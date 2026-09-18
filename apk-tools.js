/**
 * apk-tools.js — static analysis of Android APK files.
 *
 * Named explicitly as a missing capability earlier ("APK analyzer"), and
 * a real, recurring need: every app in this user's world — the lottery
 * app, Make Informed Decisions, the Reno driver scheduler debug build —
 * has gone through a no-code builder or a manual re-sign at some point,
 * and those are exactly the steps that produce a corrupted zip, a
 * mismatched signing identity, or a package that silently won't install.
 * "Why won't this APK install" is a real, recurring, answerable question.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 *
 * An APK is a ZIP file, optionally followed by an "APK Signing Block"
 * inserted just before the ZIP central directory (v2/v3 signature
 * scheme). This file:
 *
 *   1. Verifies ZIP structural integrity — every central directory entry
 *      has a matching local file header, and every entry's declared CRC32
 *      matches the CRC32 of its actual (decompressed) bytes. This alone
 *      catches the single most common real-world failure: a truncated or
 *      bit-flipped download/export.
 *   2. Checks zipalign — whether uncompressed entries start on the byte
 *      boundary Android's installer expects (4 bytes generally, 4096 for
 *      native .so libraries under the modern "don't extract native libs"
 *      convention). Misalignment doesn't always block installation but
 *      it's a real, commonly-hit build-pipeline mistake.
 *   3. Locates and structurally parses the APK Signing Block (v2/v3),
 *      extracts the embedded X.509 certificate(s) via Node's own
 *      crypto.X509Certificate (subject, issuer, validity, fingerprint),
 *      and CRYPTOGRAPHICALLY VERIFIES each signature in the block against
 *      its certificate's public key. This proves the signing block's own
 *      internal claims are self-consistent and were really produced by
 *      whoever holds the private key for that certificate.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM: verifying a signature over the
 * signing block does not, by itself, prove the ZIP content wasn't
 * altered after signing — that requires recomputing Android's specific
 * chunked content-digest algorithm over the whole file and comparing it
 * to the digest the signing block claims, which this file does not
 * attempt. Getting that recomputation subtly wrong would be worse than
 * not having it: a false "verified" is more dangerous than an honest
 * "not checked." So the digest value is reported as read from the file,
 * clearly labeled as the signer's OWN claim, never as independently
 * confirmed — the same discipline as getAssetInfo() in trading.js
 * (structural tradability, not live halt detection) and interpretSound()
 * in sensors.js (a rough comparison, not a calibrated measurement).
 * ZIP-level CRC32 integrity (point 1) remains full, independent proof
 * that the content matches what's IN the file — it just doesn't prove
 * that content matches what was originally signed.
 *
 * Nothing here executes any code from the APK. It is read as bytes and
 * parsed as data, the same posture as web-read.js toward a fetched page.
 */

import zlib from "node:zlib";
import crypto from "node:crypto";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const APK_SIG_BLOCK_MAGIC = "APK Sig Block 42";
const ID_SIGNATURE_V2 = 0x7109871a;
const ID_SIGNATURE_V3 = 0xf05368c0;

const SIGNATURE_ALGORITHMS = {
  0x0101: { name: "RSASSA-PSS with SHA2-256", verify: (data, key, sig) =>
    crypto.verify("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig) },
  0x0102: { name: "RSASSA-PSS with SHA2-512", verify: (data, key, sig) =>
    crypto.verify("sha512", data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }, sig) },
  0x0103: { name: "RSASSA-PKCS1-v1_5 with SHA2-256", verify: (data, key, sig) =>
    crypto.verify("sha256", data, key, sig) },
  0x0104: { name: "RSASSA-PKCS1-v1_5 with SHA2-512", verify: (data, key, sig) =>
    crypto.verify("sha512", data, key, sig) },
  0x0201: { name: "ECDSA with SHA2-256", verify: (data, key, sig) =>
    crypto.verify("sha256", data, key, sig) },
  0x0202: { name: "ECDSA with SHA2-512", verify: (data, key, sig) =>
    crypto.verify("sha512", data, key, sig) },
  0x0301: { name: "DSA with SHA2-256", verify: (data, key, sig) =>
    crypto.verify("sha256", data, key, sig) }
};

/* ------------------------------------------------------------------ *
 * ZIP structure
 * ------------------------------------------------------------------ */

/**
 * Find the End Of Central Directory record. It sits at the end of the
 * file, but a trailing comment (up to 65535 bytes) can push it back
 * further, so this searches backward for the signature rather than
 * assuming a fixed offset.
 */
export function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.length - i >= 4 && buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      const commentLen = buf.readUInt16LE(i + 20);
      // The real EOCD's comment length must exactly reach the end of the
      // file — otherwise this is a coincidental 4-byte match inside a
      // comment or entry data, not the actual record.
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  return -1;
}

/**
 * Parse the central directory into a list of entries. Returns
 * { ok, entries, eocdOffset, cdOffset, cdSize, error }.
 *
 * ZIP64 (needed above ~4GB or 65535 entries) is detected but not
 * followed — an APK that large or that fragmented is vanishingly rare,
 * and misreading ZIP64 fields as regular ones would silently produce
 * wrong offsets, which is worse than declining.
 */
export function parseCentralDirectory(buf) {
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset === -1) {
    return { ok: false, error: "No End Of Central Directory record found — this isn't a valid ZIP/APK file, or it's truncated." };
  }

  const numEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (numEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, error: "This file uses ZIP64 (very large or very many entries), which this tool does not parse." };
  }
  if (cdOffset + cdSize > eocdOffset || cdOffset >= buf.length) {
    return { ok: false, error: "Central directory offsets don't fit inside the file — it's corrupt or truncated." };
  }

  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  while (p < end) {
    if (buf.readUInt32LE(p) !== CENTRAL_DIR_SIGNATURE) {
      return { ok: false, error: `Central directory entry #${entries.length} has a bad signature at offset ${p} — the directory is corrupt.` };
    }
    const compression = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const fileNameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const nameStart = p + 46;
    const fileName = buf.subarray(nameStart, nameStart + fileNameLen).toString("utf8");

    entries.push({
      fileName,
      compression,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: fileName.endsWith("/"),
      unixMode: (externalAttrs >>> 16) & 0xffff
    });

    p = nameStart + fileNameLen + extraLen + commentLen;
  }

  if (entries.length !== numEntries) {
    return { ok: false, error: `Central directory declares ${numEntries} entries but ${entries.length} were actually parseable before running out of room — it's corrupt.` };
  }

  return { ok: true, entries, eocdOffset, cdOffset, cdSize };
}

/**
 * Read one entry's local file header and return where its actual
 * (possibly compressed) data starts, plus the header's own copy of the
 * filename/sizes for cross-checking against the central directory.
 */
function readLocalFileHeader(buf, offset) {
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    return { ok: false, error: `No valid local file header at offset ${offset}.` };
  }
  const compression = buf.readUInt16LE(offset + 8);
  const crc32 = buf.readUInt32LE(offset + 14);
  const compressedSize = buf.readUInt32LE(offset + 18);
  const uncompressedSize = buf.readUInt32LE(offset + 22);
  const fileNameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const fileName = buf.subarray(offset + 30, offset + 30 + fileNameLen).toString("utf8");
  const dataStart = offset + 30 + fileNameLen + extraLen;

  return { ok: true, compression, crc32, compressedSize, uncompressedSize, fileName, dataStart };
}

/**
 * Verify every entry: its local header exists and agrees with the
 * central directory, and its actual bytes decompress to the declared
 * size with the declared CRC32. This is full, independent proof the
 * file's content matches what the ZIP itself claims — the most common
 * real failure (a truncated export, a corrupted transfer) shows up here
 * directly, with no dependency on any signing block existing at all.
 */
export function verifyZipIntegrity(buf) {
  const cd = parseCentralDirectory(buf);
  if (!cd.ok) return { ok: false, error: cd.error, entries: [] };

  const results = [];
  let corrupt = 0;

  for (const entry of cd.entries) {
    const local = readLocalFileHeader(buf, entry.localHeaderOffset);
    if (!local.ok) {
      corrupt++;
      results.push({ fileName: entry.fileName, ok: false, problem: local.error });
      continue;
    }
    if (local.fileName !== entry.fileName) {
      corrupt++;
      results.push({ fileName: entry.fileName, ok: false, problem: `Local header name "${local.fileName}" doesn't match central directory name "${entry.fileName}".` });
      continue;
    }

    const dataEnd = local.dataStart + entry.compressedSize;
    if (dataEnd > buf.length) {
      corrupt++;
      results.push({ fileName: entry.fileName, ok: false, problem: `Declared size runs past the end of the file — truncated.` });
      continue;
    }

    const raw = buf.subarray(local.dataStart, dataEnd);
    let decompressed;
    try {
      if (entry.compression === 0) decompressed = raw;
      else if (entry.compression === 8) decompressed = zlib.inflateRawSync(raw);
      else {
        // Compression methods other than store/deflate exist but are rare
        // in real-world APKs; reported, not treated as a failure.
        results.push({ fileName: entry.fileName, ok: true, note: `Uses compression method ${entry.compression}, not checked (only store/deflate are verified).` });
        continue;
      }
    } catch (e) {
      corrupt++;
      results.push({ fileName: entry.fileName, ok: false, problem: `Failed to decompress: ${e.message}` });
      continue;
    }

    const actualCrc = zlib.crc32(decompressed);
    if (decompressed.length !== entry.uncompressedSize) {
      corrupt++;
      results.push({ fileName: entry.fileName, ok: false, problem: `Decompressed to ${decompressed.length} bytes, expected ${entry.uncompressedSize}.` });
    } else if (actualCrc >>> 0 !== entry.crc32 >>> 0) {
      corrupt++;
      results.push({ fileName: entry.fileName, ok: false, problem: `CRC32 mismatch — content doesn't match what the ZIP directory claims.` });
    } else {
      results.push({ fileName: entry.fileName, ok: true });
    }
  }

  return {
    ok: corrupt === 0,
    totalEntries: results.length,
    corruptEntries: corrupt,
    entries: results,
    note: corrupt === 0
      ? "Every entry's content matches its declared checksum. The ZIP structure itself is intact."
      : `${corrupt} of ${results.length} entries failed integrity verification — this file is corrupt or was tampered with.`
  };
}

/**
 * zipalign check. Android's installer wants uncompressed ("stored")
 * entries to start on a 4-byte boundary in general, and native .so
 * libraries specifically on a 4096-byte (page) boundary under the
 * modern extractNativeLibs=false convention — otherwise the OS can't
 * mmap them directly out of the APK. Compressed entries are decompressed
 * at install time regardless of their offset, so only stored entries
 * are meaningfully checked here.
 */
export function checkZipAlignment(buf) {
  const cd = parseCentralDirectory(buf);
  if (!cd.ok) return { ok: false, error: cd.error };

  const problems = [];
  let checkedStored = 0;

  for (const entry of cd.entries) {
    if (entry.compression !== 0 || entry.isDirectory) continue;
    const local = readLocalFileHeader(buf, entry.localHeaderOffset);
    if (!local.ok) continue; // already reported by verifyZipIntegrity

    checkedStored++;
    const isNativeLib = /^lib\/[^/]+\/[^/]+\.so$/.test(entry.fileName);
    const requiredAlignment = isNativeLib ? 4096 : 4;

    if (local.dataStart % requiredAlignment !== 0) {
      problems.push({
        fileName: entry.fileName,
        dataStart: local.dataStart,
        requiredAlignment,
        note: isNativeLib
          ? "Native library not page-aligned — will fail to load directly from the APK on devices/configs that need extractNativeLibs=false."
          : "Uncompressed entry not 4-byte aligned."
      });
    }
  }

  return {
    ok: problems.length === 0,
    storedEntriesChecked: checkedStored,
    misaligned: problems,
    note: checkedStored === 0
      ? "No uncompressed entries to check (everything in this APK is compressed)."
      : problems.length === 0
        ? "All uncompressed entries are correctly aligned."
        : `${problems.length} entr${problems.length === 1 ? "y is" : "ies are"} misaligned — run zipalign, or rebuild through a pipeline that does.`
  };
}

/* ------------------------------------------------------------------ *
 * APK Signing Block (v2 / v3)
 * ------------------------------------------------------------------ */

/**
 * Locate the APK Signing Block, which — if present — sits immediately
 * before the ZIP central directory. Its own trailing 24 bytes are
 * [size-of-block (8 bytes)] [magic "APK Sig Block 42" (16 bytes)], and
 * the same size value is repeated at the very start of the block, which
 * is how its start is found by working backward from the central
 * directory rather than forward from anywhere else in the file.
 */
export function findApkSigningBlock(buf) {
  const cd = parseCentralDirectory(buf);
  if (!cd.ok) return { found: false, error: cd.error };

  const { cdOffset } = cd;
  if (cdOffset < 24) return { found: false, reason: "File too small to contain a signing block before the central directory." };

  const magic = buf.subarray(cdOffset - 16, cdOffset).toString("latin1");
  if (magic !== APK_SIG_BLOCK_MAGIC) {
    return { found: false, reason: "No APK Signing Block magic found — this APK is unsigned, v1 (JAR)-only signed, or was built without v2/v3 signing." };
  }

  const trailingSize = buf.readBigUInt64LE(cdOffset - 24);
  const blockStart = cdOffset - 8 - Number(trailingSize);
  if (blockStart < 0) return { found: false, reason: "Signing block size field is inconsistent with the file layout." };

  const leadingSize = buf.readBigUInt64LE(blockStart);
  if (leadingSize !== trailingSize) {
    return { found: false, reason: "Signing block's leading and trailing size fields disagree — the block is corrupt." };
  }

  // Parse the ID-length-value pairs inside the block.
  const pairs = [];
  let p = blockStart + 8;
  const pairsEnd = cdOffset - 24;
  while (p < pairsEnd) {
    if (p + 12 > pairsEnd) break; // not enough room for another pair header
    const pairLen = Number(buf.readBigUInt64LE(p));
    const id = buf.readUInt32LE(p + 8);
    const valueStart = p + 12;
    const valueEnd = p + 8 + pairLen;
    if (valueEnd > pairsEnd) break;
    pairs.push({ id, value: buf.subarray(valueStart, valueEnd) });
    p = valueEnd;
  }

  return { found: true, blockStart, blockSize: Number(trailingSize), pairs };
}

/** Read a uint32-length-prefixed sequence of items, in order. */
function readSequence(buf, start, itemReader) {
  const totalLen = buf.readUInt32LE(start);
  let p = start + 4;
  const seqEnd = p + totalLen;
  const items = [];
  while (p < seqEnd && p + 4 <= buf.length) {
    const itemLen = buf.readUInt32LE(p);
    const itemStart = p + 4;
    items.push(itemReader(buf, itemStart, itemStart + itemLen));
    p = itemStart + itemLen;
  }
  return { items, end: p, declaredEnd: seqEnd };
}

/**
 * Parse a v2 or v3 signature-scheme block's value into its signers. Both
 * schemes share this exact signer/signed-data/signature/public-key
 * layout, differing only in the outer pair ID used to find the block and
 * (for v3) an extra minSdkVersion field this does not need to read.
 */
function parseSigners(value) {
  const signersSeq = readSequence(value, 0, (b, s, e) => b.subarray(s, e));

  return signersSeq.items.map((signer) => {
    let sp = 0;
    const sdLen = signer.readUInt32LE(sp);
    const signedData = signer.subarray(sp + 4, sp + 4 + sdLen);
    sp += 4 + sdLen;

    const sigsSeq = readSequence(signer, sp, (b, s) => {
      const algId = b.readUInt32LE(s);
      const sigLen = b.readUInt32LE(s + 4);
      return { algId, algName: (SIGNATURE_ALGORITHMS[algId] || {}).name || `unknown (0x${algId.toString(16)})`, signature: b.subarray(s + 8, s + 8 + sigLen) };
    });
    sp = sigsSeq.end;

    const pkLen = signer.readUInt32LE(sp);
    const publicKeyDer = signer.subarray(sp + 4, sp + 4 + pkLen);

    // Within signed data: digests, then certificates, then attributes.
    // Parsed separately from, and after, everything needed to verify a
    // signature (signedData/signatures/publicKeyDer above) — signature
    // verification only needs signedData as an opaque byte blob, so a
    // signing block whose digest/certificate sub-structure is corrupt or
    // non-standard should still be able to report a verified/not-verified
    // result rather than losing that entirely to a parse exception here.
    let digests = [];
    let certificates = [];
    let structureError = null;
    try {
      const digestsSeq = readSequence(signedData, 0, (b, s) => {
        const algId = b.readUInt32LE(s);
        const digestLen = b.readUInt32LE(s + 4);
        return { algId, digest: b.subarray(s + 8, s + 8 + digestLen) };
      });
      const certsSeq = readSequence(signedData, digestsSeq.end, (b, s, e) => b.subarray(s, e));
      digests = digestsSeq.items;
      certificates = certsSeq.items;
    } catch (e) {
      structureError = `Could not parse digests/certificates out of signed data: ${e.message}`;
    }

    return {
      signedData,
      digests,
      certificates,
      structureError,
      signatures: sigsSeq.items,
      publicKeyDer
    };
  });
}

/** Inspect one DER-encoded X.509 certificate using Node's own parser. */
export function inspectCertificate(certDer) {
  try {
    const cert = new crypto.X509Certificate(certDer);
    const now = new Date();
    const validTo = new Date(cert.validTo);
    return {
      ok: true,
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      isExpired: validTo < now,
      isSelfSigned: cert.subject === cert.issuer,
      fingerprint256: cert.fingerprint256,
      serialNumber: cert.serialNumber
    };
  } catch (e) {
    return { ok: false, error: `Could not parse certificate: ${e.message}` };
  }
}

/**
 * Full signing-block analysis: find it, parse every signer, verify every
 * signature against its own embedded certificate, and report certificate
 * details. This is the cryptographic core — see the file header for
 * exactly what "verified" does and doesn't prove here.
 */
export function analyzeSigningBlock(buf) {
  const block = findApkSigningBlock(buf);
  if (!block.found) return { present: false, reason: block.reason || block.error };

  const schemes = [];
  for (const [id, name] of [[ID_SIGNATURE_V2, "v2"], [ID_SIGNATURE_V3, "v3"]]) {
    const pair = block.pairs.find((p) => p.id === id);
    if (!pair) continue;

    let signers;
    try {
      signers = parseSigners(pair.value);
    } catch (e) {
      schemes.push({ scheme: name, ok: false, error: `Failed to parse: ${e.message}` });
      continue;
    }

    const signerReports = signers.map((signer) => {
      const certs = signer.certificates.map((c) => inspectCertificate(c));
      const primaryCert = certs[0];

      const signatureResults = signer.signatures.map((sig) => {
        const algo = SIGNATURE_ALGORITHMS[sig.algId];
        if (!algo) return { algorithm: sig.algName, verified: null, note: "Unrecognized algorithm ID — not verified." };
        if (!primaryCert || !primaryCert.ok) return { algorithm: sig.algName, verified: null, note: "No usable certificate to verify against." };
        try {
          const certObj = new crypto.X509Certificate(signer.certificates[0]);
          const verified = algo.verify(signer.signedData, certObj.publicKey, sig.signature);
          return { algorithm: sig.algName, verified, note: verified ? undefined : "Signature does NOT match the embedded certificate — the signing block is corrupt or was tampered with." };
        } catch (e) {
          return { algorithm: sig.algName, verified: null, note: `Could not verify: ${e.message}` };
        }
      });

      return {
        certificates: certs,
        digests: signer.digests.map((d) => ({
          algorithm: (SIGNATURE_ALGORITHMS[d.algId] || {}).name || `unknown (0x${d.algId.toString(16)})`,
          // Reported as the signer's own claim — see file header: this is
          // NOT independently recomputed from the APK's actual content.
          claimedDigestHex: d.digest.toString("hex")
        })),
        signatures: signatureResults,
        allSignaturesVerified: signatureResults.length > 0 && signatureResults.every((s) => s.verified === true)
      };
    });

    schemes.push({ scheme: name, ok: true, signerCount: signerReports.length, signers: signerReports });
  }

  const otherPairs = block.pairs.filter((p) => p.id !== ID_SIGNATURE_V2 && p.id !== ID_SIGNATURE_V3);

  return {
    present: true,
    blockSizeBytes: block.blockSize,
    schemes,
    otherBlocksFound: otherPairs.map((p) => `0x${p.id.toString(16)} (${p.value.length} bytes)`),
    note: "Signature verification here proves the signing block's certificate really produced these signatures over the block's own claimed content digest — it does not independently re-derive that digest from the APK's actual bytes (see module notes). ZIP-level integrity (verifyZipIntegrity) is the independent check that the file's actual content is intact."
  };
}

/* ------------------------------------------------------------------ *
 * Top-level diagnosis
 * ------------------------------------------------------------------ */

/**
 * Everything above, combined into one report with a plain-language
 * summary. Never claims "will install" as a guarantee — real
 * installability also depends on the target device's API level vs.
 * targetSdk, whether a differently-signed version is already installed,
 * and available storage, none of which is knowable from the file alone.
 */
export function diagnoseApk(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("diagnoseApk expects a Buffer of the raw APK file.");

  const integrity = verifyZipIntegrity(buf);
  if (!integrity.ok && integrity.entries.length === 0) {
    return {
      classification: "NOT_A_VALID_APK",
      summary: integrity.error,
      integrity
    };
  }

  const alignment = checkZipAlignment(buf);
  const signing = analyzeSigningBlock(buf);

  const findings = [];
  if (!integrity.ok) findings.push(`ZIP integrity: ${integrity.note}`);
  if (!alignment.ok) findings.push(`Alignment: ${alignment.note}`);
  if (!signing.present) findings.push(`Signing: ${signing.reason}`);
  else {
    for (const scheme of signing.schemes) {
      if (!scheme.ok) { findings.push(`Signature scheme ${scheme.scheme}: ${scheme.error}`); continue; }
      for (const signer of scheme.signers) {
        if (!signer.allSignaturesVerified) {
          findings.push(`Signature scheme ${scheme.scheme}: a signature failed verification against its own certificate — likely tampered or corrupt.`);
        }
        for (const cert of signer.certificates) {
          if (cert.ok && cert.isExpired) findings.push(`Signing certificate expired ${cert.validTo} (subject: ${cert.subject}).`);
        }
      }
    }
  }

  let classification;
  if (!integrity.ok) classification = "CORRUPT";
  else if (signing.present && signing.schemes.some((s) => s.ok && s.signers.some((sg) => !sg.allSignaturesVerified))) classification = "SIGNATURE_INVALID";
  else if (!signing.present) classification = "UNSIGNED_OR_V1_ONLY";
  else classification = "STRUCTURALLY_SOUND";

  const summaries = {
    CORRUPT: "This file's ZIP structure is corrupt — some entries' content doesn't match what the archive directory claims. This is almost always a truncated download/export or a bit-level transfer error, not a signing problem.",
    SIGNATURE_INVALID: "The ZIP structure is intact, but a signature in the signing block does not verify against its own embedded certificate. That block was altered after signing, or is corrupt.",
    UNSIGNED_OR_V1_ONLY: "The ZIP structure is intact but no v2/v3 signing block was found. This APK may be unsigned (won't install on a real device), or signed only with the older v1 (JAR) scheme, which this tool doesn't separately verify.",
    STRUCTURALLY_SOUND: "The ZIP structure is intact and every signature in the signing block verifies against its own certificate. This does not guarantee the file will install on any specific device (that also depends on API level, an already-installed different signature, and storage) — only that the file itself is internally consistent and its signing block is genuine."
  };

  return {
    classification,
    summary: summaries[classification],
    findings,
    integrity: { ok: integrity.ok, totalEntries: integrity.totalEntries, corruptEntries: integrity.corruptEntries, note: integrity.note },
    alignment: { ok: alignment.ok, storedEntriesChecked: alignment.storedEntriesChecked, misalignedCount: (alignment.misaligned || []).length, note: alignment.note },
    signing
  };
}
