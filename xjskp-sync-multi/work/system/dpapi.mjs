import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const POWERSHELL_ARGS = [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

const CIPHER_PREFIX = "xjskp.v1";
const IS_WINDOWS = process.platform === "win32";

export function protectValue(value) {
  const plain = String(value ?? "");
  if (IS_WINDOWS) return protectValueWindows(plain);
  return protectValuePortable(plain);
}

export function unprotectValue(cipherText) {
  const cipher = String(cipherText ?? "");
  if (IS_WINDOWS) return unprotectValueWindows(cipher);
  return unprotectValuePortable(cipher);
}

function protectValueWindows(plain) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[Text.Encoding]::UTF8",
    "$plain=[Console]::In.ReadToEnd()",
    "$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force",
    "ConvertFrom-SecureString -SecureString $secure",
  ].join("; ");
  return runPowerShell(script, plain);
}

function unprotectValueWindows(cipherText) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[Text.Encoding]::UTF8",
    "$cipher=[Console]::In.ReadToEnd()",
    "$secure=ConvertTo-SecureString -String $cipher",
    "$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }",
  ].join("; ");
  return runPowerShell(script, cipherText);
}

function runPowerShell(script, input) {
  const result = spawnSync("powershell", [...POWERSHELL_ARGS, script], {
    input,
    encoding: "utf8",
    env: buildWindowsPowerShellEnv(),
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `PowerShell exited ${result.status}`).trim());
  }
  return String(result.stdout ?? "").trim();
}

function buildWindowsPowerShellEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") {
      delete env[key];
    }
  }
  return env;
}

// --- Portable (non-Windows) implementation: AES-256-GCM keyed by XJSKP_SECRET_KEY ---

function protectValuePortable(plain) {
  const key = loadPortableKey();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const aeadKey = deriveAeadKey(key, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", aeadKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_PREFIX,
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function unprotectValuePortable(cipherText) {
  const parts = cipherText.split(":");
  if (parts.length !== 5 || parts[0] !== CIPHER_PREFIX) {
    throw new Error(
      "无法解密凭据：数据不是本机加密格式。Linux 下使用 XJSKP_SECRET_KEY 加密，Windows DPAPI 密文仅能在原 Windows 用户下解密。",
    );
  }
  const key = loadPortableKey();
  let salt;
  let iv;
  let tag;
  let encrypted;
  try {
    salt = Buffer.from(parts[1], "base64");
    iv = Buffer.from(parts[2], "base64");
    tag = Buffer.from(parts[3], "base64");
    encrypted = Buffer.from(parts[4], "base64");
  } catch {
    throw new Error("无法解密凭据：密文格式损坏。");
  }
  const aeadKey = deriveAeadKey(key, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aeadKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

function deriveAeadKey(masterKey, salt) {
  return crypto.scryptSync(masterKey, salt, 32);
}

function loadPortableKey() {
  const secret = process.env.XJSKP_SECRET_KEY;
  if (!secret || String(secret).trim().length < 8) {
    throw new Error(
      "缺少加密密钥：请设置环境变量 XJSKP_SECRET_KEY（至少 8 个字符的随机字符串），用于加密账号凭据。",
    );
  }
  return String(secret).trim();
}
