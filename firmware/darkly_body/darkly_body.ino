// Darkly body board — ESP32-S3
// Talks to the phone over USB-C (native USB serial) AND Bluetooth LE (Nordic UART).
// Generic ports: M1..M3 DC motors (TB6612FNG), S1..S4 servos, D1 on/off switch.
// The phone decides what each port *means* (tracks, arms, crane...). This board just obeys.
//
// Arduino IDE: board "ESP32S3 Dev Module", Tools > USB CDC On Boot: Enabled.
// Library: ESP32Servo (Library Manager). BLE library is built in.
//
// Protocol (one line each, ends with \n):
//   P               -> HELLO darkly-body 1 M1,M2,M3,S1,S2,S3,S4,D1
//   H               heartbeat (phone sends every ~400 ms)
//   X               stop everything
//   M <port> <speed -1..1> <ms>   run motor for ms (max 10000), then stop
//   S <port> <angle 0..180>       move servo
//   D <port> <0|1>                switch output
//   T <port> <freq Hz> <ms>       tone on a D port (piezo buzzer), freq 0 = silence
//   Q                             status: Q <uptime s> <motor speeds> <watchdog ok>
// Safety: if nothing arrives for 1500 ms, all motors stop ("STOPPED watchdog").

#include <ESP32Servo.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// ---------------- pins ----------------
const int STBY = 4;                       // TB6612 standby (both chips can share it)
// Motors ramp toward their target speed (soft start) so gears and batteries don't get slammed.
struct Motor { const char* name; int pwm, in1, in2; unsigned long until; bool running; float cur, tgt; };
Motor motors[] = {
  {"M1", 5, 6, 7, 0, false, 0, 0},
  {"M2", 15, 16, 17, 0, false, 0, 0},
  {"M3", 8, 9, 10, 0, false, 0, 0},
};
const float RAMP_PER_MS = 0.004;          // full speed in ~250 ms
const int NM = sizeof(motors) / sizeof(motors[0]);

struct ServoPort { const char* name; int pin; Servo s; bool attached; };
ServoPort servos[] = { {"S1", 11}, {"S2", 12}, {"S3", 13}, {"S4", 14} };
const int NS = sizeof(servos) / sizeof(servos[0]);

struct Switch { const char* name; int pin; };
Switch switches[] = { {"D1", 21} };
const int ND = sizeof(switches) / sizeof(switches[0]);

const unsigned long WATCHDOG_MS = 1500;
const unsigned long MAX_RUN_MS = 10000;
const int PWM_FREQ = 20000, PWM_BITS = 8;

unsigned long lastMsg = 0;
bool watchdogTripped = false;

// ---------------- BLE (Nordic UART Service) ----------------
#define NUS_SERVICE "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // phone writes here
#define NUS_TX      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"   // board notifies here
BLECharacteristic* txChar = nullptr;
bool bleConnected = false;
String bleBuf, usbBuf;

void reply(const String& s) {
  Serial.println(s);
  if (bleConnected && txChar) {
    String line = s + "\n";
    for (size_t i = 0; i < line.length(); i += 20) {
      String part = line.substring(i, min(line.length(), i + 20));
      txChar->setValue((uint8_t*)part.c_str(), part.length());
      txChar->notify();
      delay(4);
    }
  }
}

// ---------------- hardware ----------------
void motorOut(Motor& m, float speed) {
  speed = constrain(speed, -1.0f, 1.0f);
  m.cur = speed;
  int duty = (int)(fabs(speed) * 255);
  digitalWrite(m.in1, speed > 0 ? HIGH : LOW);
  digitalWrite(m.in2, speed < 0 ? HIGH : LOW);
  ledcWrite(m.pwm, duty);
}
void motorSet(Motor& m, float speed) { m.tgt = constrain(speed, -1.0f, 1.0f); m.running = m.tgt != 0 || m.cur != 0; }
void stopAll() {   // safety stop is instant, no ramp
  for (int i = 0; i < NM; i++) { motors[i].tgt = 0; motorOut(motors[i], 0); motors[i].running = false; motors[i].until = 0; }
  for (int i = 0; i < ND; i++) noTone(switches[i].pin);
}
Motor* findMotor(const String& n) { for (int i = 0; i < NM; i++) if (n.equalsIgnoreCase(motors[i].name)) return &motors[i]; return nullptr; }
ServoPort* findServo(const String& n) { for (int i = 0; i < NS; i++) if (n.equalsIgnoreCase(servos[i].name)) return &servos[i]; return nullptr; }
Switch* findSwitch(const String& n) { for (int i = 0; i < ND; i++) if (n.equalsIgnoreCase(switches[i].name)) return &switches[i]; return nullptr; }

String portList() {
  String s;
  for (int i = 0; i < NM; i++) { s += motors[i].name; s += ","; }
  for (int i = 0; i < NS; i++) { s += servos[i].name; s += ","; }
  for (int i = 0; i < ND; i++) { s += switches[i].name; s += ","; }
  s.remove(s.length() - 1);
  return s;
}

// ---------------- commands ----------------
void handle(String line) {
  line.trim();
  if (!line.length()) return;
  lastMsg = millis();
  watchdogTripped = false;

  char cmd = toupper(line[0]);
  // split into up to 4 words
  String w[4]; int n = 0; int start = 0;
  for (int i = 0; i <= (int)line.length() && n < 4; i++) {
    if (i == (int)line.length() || line[i] == ' ') { if (i > start) w[n++] = line.substring(start, i); start = i + 1; }
  }

  if (cmd == 'H') return;                                   // heartbeat, silent
  if (cmd == 'P') { reply("HELLO darkly-body 2 " + portList() + " TONE,RAMP"); return; }
  if (cmd == 'Q') {
    String q = "Q " + String(millis() / 1000);
    for (int i = 0; i < NM; i++) q += " " + String(motors[i].name) + "=" + String(motors[i].cur, 2);
    reply(q); return;
  }
  if (cmd == 'T' && n >= 4) {
    Switch* d = findSwitch(w[1]);
    if (!d) { reply("ERR no buzzer port " + w[1]); return; }
    long f = w[2].toInt(); unsigned long ms = min((unsigned long)max(0L, w[3].toInt()), (unsigned long)5000);
    if (f <= 0) noTone(d->pin); else tone(d->pin, constrain(f, 20, 20000), ms);
    return;                                  // no OK: songs send these fast
  }
  if (cmd == 'X') { stopAll(); reply("OK"); return; }

  if (cmd == 'M' && n >= 4) {
    Motor* m = findMotor(w[1]);
    if (!m) { reply("ERR no motor " + w[1]); return; }
    float sp = w[2].toFloat();
    unsigned long ms = min((unsigned long)max(0L, w[3].toInt()), MAX_RUN_MS);
    motorSet(*m, sp);
    m->until = ms ? millis() + ms : 0;
    reply("OK"); return;
  }
  if (cmd == 'S' && n >= 3) {
    ServoPort* s = findServo(w[1]);
    if (!s) { reply("ERR no servo " + w[1]); return; }
    if (!s->attached) { s->s.setPeriodHertz(50); s->s.attach(s->pin, 500, 2400); s->attached = true; }
    s->s.write(constrain(w[2].toInt(), 0, 180));
    reply("OK"); return;
  }
  if (cmd == 'D' && n >= 3) {
    Switch* d = findSwitch(w[1]);
    if (!d) { reply("ERR no switch " + w[1]); return; }
    digitalWrite(d->pin, w[2].toInt() ? HIGH : LOW);
    reply("OK"); return;
  }
  reply("ERR bad command: " + line);
}

void feed(String& buf, const char* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    char c = data[i];
    if (c == '\n' || c == '\r') { if (buf.length()) { handle(buf); buf = ""; } }
    else if (buf.length() < 96) buf += c;
  }
}

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue();                 // Arduino-ESP32 core 3.x returns String
    feed(bleBuf, v.c_str(), v.length());
  }
};
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleConnected = true; }
  void onDisconnect(BLEServer* s) override { bleConnected = false; stopAll(); s->getAdvertising()->start(); }
};

// ---------------- setup / loop ----------------
void setup() {
  Serial.begin(115200);
  pinMode(STBY, OUTPUT); digitalWrite(STBY, HIGH);
  for (int i = 0; i < NM; i++) {
    pinMode(motors[i].in1, OUTPUT); pinMode(motors[i].in2, OUTPUT);
    ledcAttach(motors[i].pwm, PWM_FREQ, PWM_BITS);          // core 3.x API
    motorSet(motors[i], 0);
  }
  for (int i = 0; i < ND; i++) { pinMode(switches[i].pin, OUTPUT); digitalWrite(switches[i].pin, LOW); }

  BLEDevice::init("Darkly Body");
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService* svc = server->createService(NUS_SERVICE);
  txChar = svc->createCharacteristic(NUS_TX, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic* rx = svc->createCharacteristic(NUS_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCallbacks());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  lastMsg = millis();
  reply("HELLO darkly-body 2 " + portList() + " TONE,RAMP");
}

unsigned long lastRamp = 0;

void loop() {
  while (Serial.available()) { char c = Serial.read(); feed(usbBuf, &c, 1); }

  unsigned long now = millis();
  for (int i = 0; i < NM; i++) {
    if (motors[i].until && (long)(now - motors[i].until) >= 0) { motors[i].tgt = 0; motors[i].until = 0; }
  }
  // soft start / soft stop
  unsigned long dtr = now - lastRamp;
  if (dtr >= 5) {
    lastRamp = now;
    for (int i = 0; i < NM; i++) {
      Motor& m = motors[i];
      if (m.cur == m.tgt) { m.running = m.cur != 0; continue; }
      float step = RAMP_PER_MS * dtr, diff = m.tgt - m.cur;
      motorOut(m, fabs(diff) <= step ? m.tgt : m.cur + (diff > 0 ? step : -step));
      m.running = true;
    }
  }
  if (!watchdogTripped && now - lastMsg > WATCHDOG_MS) {
    bool any = false; for (int i = 0; i < NM; i++) any |= motors[i].running;
    stopAll(); watchdogTripped = true;
    if (any) reply("STOPPED watchdog");
  }
  delay(2);
}
