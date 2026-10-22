export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Fields = Record<string, unknown>;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|^session$|session[-_]?(id|key)/i;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

/** ซ่อนค่าที่ key ดูเป็นความลับ และ credential ที่ฝังอยู่ใน URL */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[MaxDepth]";
  if (typeof value === "string") return value.replace(URL_CREDENTIALS, `//${REDACTED}@`);
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Fields = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Fields;
  /** ปลายทางของบรรทัด JSON — เปลี่ยนได้ในเทสต์ */
  write?: (line: string) => void;
}

/** JSON logger หนึ่งบรรทัดต่อ event; ทุก field ผ่าน redact() ก่อนเขียน */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVELS[options.level ?? "info"];
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));

  const log = (level: LogLevel, msg: string, fields?: Fields) => {
    if (LEVELS[level] < min) return;
    const entry = redact({ time: new Date().toISOString(), level, msg, ...bindings, ...fields });
    write(JSON.stringify(entry));
  };

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}
