import { initUserModule } from "./userService.js";
import { logger } from "./logger.js";

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    const details = [
      error.message,
      "code" in error ? `code=${String(error.code)}` : undefined,
      "cause" in error ? `cause=${String(error.cause)}` : undefined,
      error.stack
    ].filter(Boolean);

    return details.join("\n");
  }

  return String(error);
};

initUserModule()
  .then(() => {
    logger.success("Base vrdv initialisee avec succes.");
    process.exit(0);
  })
  .catch((error) => {
    logger.error(`Initialisation DB impossible:\n${formatError(error)}`);
    logger.error("Verifie PostgreSQL, user postgres, mot de passe SMART, puis relance npm.cmd run db:init.");
    process.exit(1);
  });
