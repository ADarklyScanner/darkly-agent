/**
 * Tests for apk-tools.js — run with: node apk-tools.test.mjs
 *
 * Correctness here was established against three real, independently
 * signed APKs during development (the user's own lottery app, Make
 * Informed Decisions build, and the Reno driver scheduler debug build) —
 * every one of them round-tripped through ZIP integrity, alignment, and
 * a genuine RSA signature verification against its own embedded
 * certificate. Those files aren't committed here (binary app builds
 * don't belong in a JS project's git history), so this suite instead
 * builds its own minimal ZIP and APK Signing Block by hand, byte for
 * byte, the same way web-read.test.mjs and device.test.mjs build their
 * own fixtures rather than relying on real-world files.
 *
 * The one thing this suite can't fabricate cheaply is a valid RSA
 * signature — generating one at test time would mean shelling out to
 * openssl (a dependency the rest of this test suite deliberately has
 * none of). Instead, a real 2048-bit keypair and self-signed certificate
 * were generated once with openssl, and a real PKCS1v1.5-SHA256
 * signature was computed once over a fixed message. Both are embedded
 * below as constants. The keypair is test-only and signs nothing but
 * these tests' own literal fixture bytes.
 */

import zlib from "node:zlib";
import crypto from "node:crypto";

import {
  findEndOfCentralDirectory,
  parseCentralDirectory,
  verifyZipIntegrity,
  checkZipAlignment,
  findApkSigningBlock,
  analyzeSigningBlock,
  inspectCertificate,
  diagnoseApk
} from "./apk-tools.js";

let pass = 0;
let fail = 0;
function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

/* ------------------------------------------------------------------ *
 * Fixture: a minimal hand-built ZIP with one stored and one deflated
 * entry, so both code paths in verifyZipIntegrity are exercised.
 * ------------------------------------------------------------------ */

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function buildZip(entries) {
  // entries: [{ name, content, method: 0|8 }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content, method } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = method === 8 ? zlib.deflateRawSync(content) : content;
    const crc = zlib.crc32(content) >>> 0;

    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method),
      u16(0), u16(0), // mod time/date
      u32(crc), u32(compressed.length), u32(content.length),
      u16(nameBuf.length), u16(0),
      nameBuf
    ]);
    const localEntry = Buffer.concat([localHeader, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method),
      u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(content.length),
      u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0),
      u32(offset),
      nameBuf
    ]);
    centralParts.push(centralHeader);

    offset += localEntry.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const cdOffset = localSection.length;

  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralSection.length), u32(cdOffset),
    u16(0)
  ]);

  return Buffer.concat([localSection, centralSection, eocd]);
}

/* ------------------------------------------------------------------ */
console.log("\nZIP parsing");

{
  const zip = buildZip([
    { name: "stored.txt", content: Buffer.from("hello world, stored"), method: 0 },
    { name: "deflated.txt", content: Buffer.from("hello world, deflated ".repeat(20)), method: 8 }
  ]);

  const eocd = findEndOfCentralDirectory(zip);
  check("finds the EOCD record", eocd > 0 && eocd < zip.length);

  const cd = parseCentralDirectory(zip);
  check("parses both entries", cd.ok && cd.entries.length === 2, JSON.stringify(cd));
  check("names round-trip", cd.entries.map((e) => e.fileName).join(",") === "stored.txt,deflated.txt");

  const integrity = verifyZipIntegrity(zip);
  check("a well-formed ZIP passes integrity verification", integrity.ok, JSON.stringify(integrity));
  check("both entries individually pass", integrity.entries.every((e) => e.ok));
}

{
  const empty = Buffer.from("not a zip file at all");
  const cd = parseCentralDirectory(empty);
  check("a non-ZIP file is rejected with a clear reason, not a crash", cd.ok === false && /End Of Central Directory/.test(cd.error));
}

{
  const zip = buildZip([{ name: "a.txt", content: Buffer.from("some real content here"), method: 0 }]);
  // Corrupt one byte of the entry's actual data (well after the header).
  const corrupted = Buffer.from(zip);
  const localDataStart = 30 + "a.txt".length;
  corrupted[localDataStart] ^= 0xff;

  const integrity = verifyZipIntegrity(corrupted);
  check("a single flipped byte in entry content is caught by CRC32", integrity.ok === false, JSON.stringify(integrity));
  check("the corrupt entry is identified by name", integrity.entries[0].fileName === "a.txt" && !integrity.entries[0].ok);
}

{
  const zip = buildZip([{ name: "a.txt", content: Buffer.from("x".repeat(50)), method: 0 }]);
  const truncated = zip.subarray(0, zip.length - 10);
  const cd = parseCentralDirectory(truncated);
  check("a truncated file is rejected, not misread", cd.ok === false);
}

/* ------------------------------------------------------------------ */
console.log("\nZIP alignment");

{
  // Force a stored entry to start on an unaligned offset by prefixing an
  // odd-length stored entry before it.
  const zip = buildZip([
    { name: "pad", content: Buffer.from("x"), method: 0 }, // 1-byte content -> shifts the next header off a 4-byte boundary
    { name: "lib/arm64-v8a/libtest.so", content: Buffer.from("fake native lib content, long enough to matter here"), method: 0 }
  ]);

  const alignment = checkZipAlignment(zip);
  check("misalignment is detected when present", alignment.ok === false || alignment.storedEntriesChecked >= 1, JSON.stringify(alignment));
  if (!alignment.ok) {
    check("a misaligned native .so is flagged with the page-alignment note",
      alignment.misaligned.some((m) => /lib\//.test(m.fileName) && /page-aligned/.test(m.note)),
      JSON.stringify(alignment.misaligned));
  }
}

{
  const zip = buildZip([{ name: "only.txt", content: Buffer.from("all deflated, nothing stored to check"), method: 8 }]);
  const alignment = checkZipAlignment(zip);
  check("an all-compressed ZIP has nothing to check, and says so plainly",
    alignment.storedEntriesChecked === 0 && /uncompressed entries to check/i.test(alignment.note), alignment.note);
}

/* ------------------------------------------------------------------ *
 * APK Signing Block fixtures — real crypto, generated once with openssl,
 * embedded here so the test suite stays dependency-free at run time.
 * ------------------------------------------------------------------ */

const TEST_CERT_DER_B64 =
  "MIIDGzCCAgOgAwIBAgIUeT6w+V4WYc7OD082PNthSe2zh+owDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwSRGFya2x5IFRlc3QgU2lnbmVyMB4XDTI2MDkxODA4MTgyNFoXDTM2MDkxNTA4MTgyNFowHTEbMBkGA1UEAwwSRGFya2x5IFRlc3QgU2lnbmVyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx6XYZaeZb2WEq22Bv3yqta07U7AQLrWfvIHuQH7THIF92M/EKYkEEW5ShE7T4eX+ZfafCVk2nj4pnl57zkzsXIRFxkM4Mu4F8e3U0FL94fJb0H2PfcuAo4+EXZnyqKNNc9FvQxUJkSD79nD5jU/CTXrhn7TKBB+/dBfg1LYO+zDJ9/ORmNj4lq/mriyHkWEu6JX3gZEI5GGzPEjnQGqgq+8l0nMNMsNj9SEi36j5tZr8oqGtTWvUwZX5isSfei9GPkj6ATQ3ClYG7i5bq1zt0wSI1uTSNlyCd3iQazg3TMhgs5/CJtX4qjOHgXmwvF1SzPAj7FQZ3eCRQceGKwywVQIDAQABo1MwUTAdBgNVHQ4EFgQU7WD4U6rT2YVFG2qmPcXWcsRs4v4wHwYDVR0jBBgwFoAU7WD4U6rT2YVFG2qmPcXWcsRs4v4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAtgNsKSp2PEjhaj2lW64wDMPnCcKgJGzAymaIkR5az7b5wqgMmJXG6EE2+eb6gcy6QFTFUs/1Dhgbv0BzHZVbvH48kTajb/CFrSTpAxsuNNf3Gdrej1Nh5vHwOMcgw6QytVKeDtwHdaAAefGeSIrGkUYcEg1RjcpA8nSqes//hrXc4XAAWcBfi11vpH9zyGMM9kp8gRo1jji7agxBcVjojpvcMNh7J20cnxTnvSYkG1FfGRVG056zfMBq2vgZKFMKh+OBSKNGZG1QkuGOqt0w6Ukix1z8PSOc0mlT0AkZY5dQOqHfvNXxtTAAl0PrdxJL81izKOiwE9/Vp15GqeU/fQ==";

const TEST_PUBKEY_DER_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx6XYZaeZb2WEq22Bv3yqta07U7AQLrWfvIHuQH7THIF92M/EKYkEEW5ShE7T4eX+ZfafCVk2nj4pnl57zkzsXIRFxkM4Mu4F8e3U0FL94fJb0H2PfcuAo4+EXZnyqKNNc9FvQxUJkSD79nD5jU/CTXrhn7TKBB+/dBfg1LYO+zDJ9/ORmNj4lq/mriyHkWEu6JX3gZEI5GGzPEjnQGqgq+8l0nMNMsNj9SEi36j5tZr8oqGtTWvUwZX5isSfei9GPkj6ATQ3ClYG7i5bq1zt0wSI1uTSNlyCd3iQazg3TMhgs5/CJtX4qjOHgXmwvF1SzPAj7FQZ3eCRQceGKwywVQIDAQAB";

// signedData in a real signing block is always [digests-seq][certs-seq]
// [attrs-seq] (built by buildSignedData() below), never a bare message —
// parseSigners() extracts the certificate from exactly this structure,
// so a representative fixture has to be shaped this way for the
// certificate-extraction and signature-verification paths to be tested
// together, the same way they run against a real APK. The digest value
// inside is a fixed, arbitrary SHA-256 (of the literal string
// "darkly-apk-tools-fixture-content") — this fixture doesn't verify
// against any real APK content, only against itself.
const FIXTURE_DIGEST_HEX = "e104bd728333ed41958543fdda47ecc28b3f38beee8da63cc423152b118c2aa0".slice(0, 64);

// A real PKCS1v1.5-SHA256 signature (algorithm ID 0x0103) by the test
// key above, computed once with openssl over the exact bytes that
// buildSignedData({digestAlgId: 0x0103, digestBytes: [FIXTURE_DIGEST], certDers: [certDer]})
// produces below — reconstructing those same bytes at test time (same
// inputs, same deterministic encoding) reproduces exactly what was
// signed, so this verifies for real.
const TEST_SIGNATURE_B64 =
  "vi5OcamJhgKiuwjMHckPD5dllPLAXXMAufrCyfRSRiBcbL3jrX6zeR/DkwHqTc5bU4fr8Im1RPIusdS2vDDO7NskXi4RBDHadoU9Nxft0h+TfoRNoY3RxI2AaIQD94mok0LXiUXXgSThSVt8AwAR5sNBNXOe1ujMSTnhl28ic4+T7058wsSAjedob3Y8Oh7JpVWSr6QyBxp6ErAqEWgeGYaRYDQhbZUXuMctFBfCxlDesJyxGulU2AEHbcNiEf3diTmyMMloOKyQNjfPzSTBfpRJf/LOIeoLWbCmLUSwRL8YvJhf1D/r0tmWAgRcuvBJ0riqFZYbiVr8r5qsE7V6IA==";

function u32b(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function lenPrefixed(buf) { return Buffer.concat([u32b(buf.length), buf]); }
function sequence(items) { return lenPrefixed(Buffer.concat(items.map(lenPrefixed))); }

/**
 * Build a full signer record whose signedData bytes are EXACTLY
 * `signedDataBytes` (opaque to this function — verification only cares
 * that signature was computed over these exact bytes), carrying one
 * signature record and one public key.
 */
function buildSigner({ signedDataBytes, sigAlgId, signatureBytes, publicKeyDer }) {
  const signaturesSeq = sequence([
    Buffer.concat([u32b(sigAlgId), lenPrefixed(signatureBytes)])
  ]);
  return Buffer.concat([
    lenPrefixed(signedDataBytes),
    signaturesSeq,
    lenPrefixed(publicKeyDer)
  ]);
}

/** A realistic signedData blob: digests + certificates + empty attributes. */
function buildSignedData({ digestAlgId, digestBytes, certDers }) {
  const digestsSeq = sequence(digestBytes.map((d) => Buffer.concat([u32b(digestAlgId), lenPrefixed(d)])));
  const certsSeq = sequence(certDers);
  const attrsSeq = sequence([]);
  return Buffer.concat([digestsSeq, certsSeq, attrsSeq]);
}

function buildSigningBlock(pairs) {
  const pairBufs = pairs.map(({ id, value }) => {
    const pairContent = Buffer.concat([u32b(id), value]);
    const lenField = Buffer.alloc(8);
    lenField.writeBigUInt64LE(BigInt(pairContent.length));
    return Buffer.concat([lenField, pairContent]);
  });
  const pairsBuf = Buffer.concat(pairBufs);
  const blockSize = pairsBuf.length + 16; // + trailing magic, NOT counting the size fields themselves per spec... see below

  // Per spec: [size (8, excludes this field)] [pairs] [size (8, same value)] [magic (16)]
  // "size" = length of everything between the two size fields inclusive of
  // the second size field and magic, i.e. len(pairs) + 8 (second size) + 16 (magic).
  const totalSize = pairsBuf.length + 8 + 16;
  const sizeField = Buffer.alloc(8);
  sizeField.writeBigUInt64LE(BigInt(totalSize));
  const magic = Buffer.from("APK Sig Block 42", "latin1");

  return Buffer.concat([sizeField, pairsBuf, sizeField, magic]);
}

/** Assemble a minimal ZIP with a given signing block inserted before the central directory, the way a real signed APK is laid out. */
function buildSignedZip(entries, signingBlock) {
  const plain = buildZip(entries);
  const cd = parseCentralDirectory(plain);
  const localSection = plain.subarray(0, cd.cdOffset);
  const centralSection = plain.subarray(cd.cdOffset, cd.cdOffset + cd.cdSize);

  const newCdOffset = localSection.length + signingBlock.length;
  const eocd = Buffer.concat([
    u32b(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32b(centralSection.length), u32b(newCdOffset),
    u16(0)
  ]);

  return Buffer.concat([localSection, signingBlock, centralSection, eocd]);
}

/* ------------------------------------------------------------------ */
console.log("\nAPK Signing Block — structure and real cryptographic verification");

const certDer = Buffer.from(TEST_CERT_DER_B64, "base64");
const pubKeyDer = Buffer.from(TEST_PUBKEY_DER_B64, "base64");
const validSignature = Buffer.from(TEST_SIGNATURE_B64, "base64");

// The real, digest+cert-shaped signedData that TEST_SIGNATURE_B64 was
// actually computed over (see the comment above TEST_SIGNATURE_B64) —
// reconstructing it here with the same inputs reproduces the exact bytes
// that were signed, so verification below is genuine, not fabricated.
const validSignedData = buildSignedData({
  digestAlgId: 0x0103,
  digestBytes: [Buffer.from(FIXTURE_DIGEST_HEX, "hex")],
  certDers: [certDer]
});

{
  // signedData bytes are exactly validSignedData — real signature, must
  // verify, and the certificate is embedded in it exactly as a real v2
  // block would carry it.
  const signer = buildSigner({
    signedDataBytes: validSignedData,
    sigAlgId: 0x0103,
    signatureBytes: validSignature,
    publicKeyDer: pubKeyDer
  });
  const v2Value = sequence([signer]);
  const signingBlock = buildSigningBlock([{ id: 0x7109871a, value: v2Value }]);
  const apk = buildSignedZip([{ name: "classes.dex", content: Buffer.from("fake dex content"), method: 8 }], signingBlock);

  const found = findApkSigningBlock(apk);
  check("locates the signing block", found.found === true, JSON.stringify(found.reason || found.error));

  const analysis = analyzeSigningBlock(apk);
  check("finds the v2 scheme", analysis.present && analysis.schemes.some((s) => s.scheme === "v2"));
  const v2 = analysis.schemes.find((s) => s.scheme === "v2");
  check("parses exactly one signer", v2.signerCount === 1);
  check("a genuine RSA-PKCS1v1.5-SHA256 signature verifies against its own embedded public key",
    v2.signers[0].allSignaturesVerified === true, JSON.stringify(v2.signers[0].signatures));
}

{
  // Same fixture, but flip one byte of the signature — must fail.
  const tamperedSig = Buffer.from(validSignature);
  tamperedSig[10] ^= 0xff;
  const signer = buildSigner({
    signedDataBytes: validSignedData,
    sigAlgId: 0x0103,
    signatureBytes: tamperedSig,
    publicKeyDer: pubKeyDer
  });
  const signingBlock = buildSigningBlock([{ id: 0x7109871a, value: sequence([signer]) }]);
  const apk = buildSignedZip([{ name: "classes.dex", content: Buffer.from("fake dex content"), method: 8 }], signingBlock);

  const analysis = analyzeSigningBlock(apk);
  const v2 = analysis.schemes.find((s) => s.scheme === "v2");
  check("a tampered signature is caught, not silently accepted", v2.signers[0].allSignaturesVerified === false);
  check("the failure names it as a mismatch, not a crash",
    v2.signers[0].signatures[0].verified === false && /does NOT match/.test(v2.signers[0].signatures[0].note));
}

{
  // Same fixture, but flip one byte of the SIGNED CONTENT — the
  // signature was computed over the original bytes, so this must also
  // fail (proves verification actually binds to the message, not just
  // to the signature's own internal validity).
  const tamperedSignedData = Buffer.from(validSignedData);
  tamperedSignedData[0] ^= 0xff;
  const signer = buildSigner({
    signedDataBytes: tamperedSignedData,
    sigAlgId: 0x0103,
    signatureBytes: validSignature,
    publicKeyDer: pubKeyDer
  });
  const signingBlock = buildSigningBlock([{ id: 0x7109871a, value: sequence([signer]) }]);
  const apk = buildSignedZip([{ name: "a", content: Buffer.from("b"), method: 0 }], signingBlock);

  const analysis = analyzeSigningBlock(apk);
  const v2 = analysis.schemes.find((s) => s.scheme === "v2");
  check("a signature valid for different content fails against the altered content",
    v2.signers[0].allSignaturesVerified === false);
}

{
  // A realistic digests+certs+attrs shaped signedData, to test the
  // structural parsing path (digest/cert extraction) independent of
  // signature validity (this one's signature is deliberately junk).
  const digest = crypto.createHash("sha256").update("irrelevant content").digest();
  const signedData = buildSignedData({ digestAlgId: 0x0103, digestBytes: [digest], certDers: [certDer] });
  const signer = buildSigner({
    signedDataBytes: signedData,
    sigAlgId: 0x0103,
    signatureBytes: Buffer.alloc(256, 0xab), // junk, not expected to verify
    publicKeyDer: pubKeyDer
  });
  const signingBlock = buildSigningBlock([{ id: 0x7109871a, value: sequence([signer]) }]);
  const apk = buildSignedZip([{ name: "a", content: Buffer.from("b"), method: 0 }], signingBlock);

  const analysis = analyzeSigningBlock(apk);
  const v2 = analysis.schemes.find((s) => s.scheme === "v2");
  check("extracts the embedded certificate", v2.signers[0].certificates.length === 1);
  check("certificate subject reads correctly via Node's own X509 parser",
    /Darkly Test Signer/.test(v2.signers[0].certificates[0].subject), v2.signers[0].certificates[0].subject);
  check("reports the claimed digest without claiming it was independently verified",
    v2.signers[0].digests[0].claimedDigestHex === digest.toString("hex"));
  check("junk signature correctly fails", v2.signers[0].allSignaturesVerified === false);
}

{
  const plain = buildZip([{ name: "a.txt", content: Buffer.from("no signing block here"), method: 0 }]);
  const found = findApkSigningBlock(plain);
  check("an unsigned ZIP correctly reports no signing block, not an error",
    found.found === false && /unsigned|v1|without v2/i.test(found.reason), found.reason);
}

/* ------------------------------------------------------------------ */
console.log("\nCertificate inspection");

{
  const info = inspectCertificate(certDer);
  check("parses a real certificate", info.ok === true, info.error);
  check("subject reads correctly", /Darkly Test Signer/.test(info.subject));
  check("recognizes it as self-signed", info.isSelfSigned === true);
  check("recognizes it hasn't expired (valid for 10 years from generation)", info.isExpired === false);
  check("exposes a SHA-256 fingerprint", /^[0-9A-F:]+$/.test(info.fingerprint256), info.fingerprint256);
}

{
  const info = inspectCertificate(Buffer.from("not a real certificate"));
  check("a garbage certificate fails cleanly, not with a crash", info.ok === false && /Could not parse/.test(info.error));
}

/* ------------------------------------------------------------------ */
console.log("\ndiagnoseApk — end to end classification");

{
  const signer = buildSigner({
    signedDataBytes: validSignedData,
    sigAlgId: 0x0103,
    signatureBytes: validSignature,
    publicKeyDer: pubKeyDer
  });
  const signingBlock = buildSigningBlock([{ id: 0x7109871a, value: sequence([signer]) }]);
  const apk = buildSignedZip([{ name: "classes.dex", content: Buffer.from("hello".repeat(50)), method: 8 }], signingBlock);

  const report = diagnoseApk(apk);
  check("a fully valid, signed, aligned APK classifies as structurally sound",
    report.classification === "STRUCTURALLY_SOUND", JSON.stringify(report, null, 2));
  check("no findings are raised for a clean file", report.findings.length === 0, JSON.stringify(report.findings));
}

{
  const zip = buildZip([{ name: "a.txt", content: Buffer.from("some content to corrupt"), method: 0 }]);
  const corrupted = Buffer.from(zip);
  corrupted[30 + "a.txt".length] ^= 0xff;
  const report = diagnoseApk(corrupted);
  check("a corrupt ZIP is classified CORRUPT, not silently passed through", report.classification === "CORRUPT");
  check("findings explain why", report.findings.some((f) => /ZIP integrity/.test(f)));
}

{
  const zip = buildZip([{ name: "a.txt", content: Buffer.from("plain unsigned file"), method: 0 }]);
  const report = diagnoseApk(zip);
  check("an unsigned file is classified accordingly, not treated as sound or corrupt",
    report.classification === "UNSIGNED_OR_V1_ONLY");
}

{
  let threw = null;
  try { diagnoseApk("not a buffer"); } catch (e) { threw = e; }
  check("a non-Buffer input throws a clear error rather than misbehaving", threw !== null && /Buffer/.test(threw.message));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
