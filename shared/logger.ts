const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
} as const;

function timestamp(): string {
  return new Date().toISOString().split('T')[1]?.replace('Z', '') ?? '';
}

function line(color: string, tag: string, message: string): void {
  console.log(
    `${colors.dim}${timestamp()}${colors.reset} ${color}${tag}${colors.reset} ${message}`,
  );
}

export const logger = {
  info: (message: string): void => line(colors.cyan, '[info] ', message),
  warn: (message: string): void => line(colors.yellow, '[warn] ', message),
  error: (message: string): void => line(colors.red, '[error]', message),
  success: (message: string): void => line(colors.green, '[ ok ] ', message),
  step: (title: string): void => console.log(`\n${colors.cyan}=== ${title} ===${colors.reset}`),
};
