const PREFIX = "zonedb:";

/** One line for stderr. Most errors thrown inside the CLI already name the tool; don't say it twice. */
export function formatCliError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message.startsWith(PREFIX) ? err.message : `${PREFIX} ${err.message}`;
}
