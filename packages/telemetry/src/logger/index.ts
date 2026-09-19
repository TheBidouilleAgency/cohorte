// Sealed NDJSON logger (PLAN U3.10).
import { appendFile } from 'node:fs/promises';
import type { SealedJson, SealedText } from '@cohorte/base';
import type { Logger, LoggerOptions, LogSink } from '../contract.ts';

export function createLogger(options: LoggerOptions): Logger {
  const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const file =
    options.sink !== 'stderr' && typeof options.sink === 'object' && 'file' in options.sink
      ? options.sink.file
      : undefined;
  const sink: LogSink =
    options.sink === 'stderr'
      ? { write: (line: string) => process.stderr.write(line) }
      : file !== undefined
        ? { write: (line: string) => void appendFile(file, line) }
        : typeof options.sink === 'object' && 'write' in options.sink
          ? options.sink
          : { write: () => undefined };
  const scope = options.scope ?? 'cohorte';
  const logger: Logger = {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childScope) => createLogger({ ...options, sink: options.sink, scope: `${scope}.${childScope}` }),
    flush: async () => {
      if (typeof sink.flush === 'function') await sink.flush();
    },
  };
  function write(level: keyof typeof rank, message: SealedText, fields?: SealedJson): void {
    if (rank[level] < rank[options.level]) return;
    const record = JSON.stringify({
      at: options.clock.now(),
      level,
      scope,
      message,
      ...(fields === undefined ? {} : { fields }),
    });
    sink.write(`${record}\n`);
  }
  return logger;
}
