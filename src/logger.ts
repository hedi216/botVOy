type LogLevel = "info" | "warn" | "error" | "success";

const formatDate = (): string => new Date().toISOString();

const write = (level: LogLevel, message: string, meta?: unknown): void => {
  const line = `[${formatDate()}] [${level.toUpperCase()}] ${message}`;

  if (level === "error") {
    console.error(line, meta ?? "");
    return;
  }

  console.log(line, meta ?? "");
};

export const logger = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
  success: (message: string, meta?: unknown) => write("success", message, meta)
};
