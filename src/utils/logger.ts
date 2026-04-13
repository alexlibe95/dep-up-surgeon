import chalk from 'chalk';

/** Human-facing log helpers (skip when --json). */
export const log = {
  info(msg: string): void {
    console.log(msg);
  },
  dim(msg: string): void {
    console.log(chalk.dim(msg));
  },
  success(msg: string): void {
    console.log(chalk.green('✔'), msg);
  },
  warn(msg: string): void {
    console.log(chalk.yellow('⚠'), msg);
  },
  error(msg: string): void {
    console.log(chalk.red('✖'), msg);
  },
  peer(msg: string): void {
    console.log(chalk.magenta('⚠ peer conflict:'), msg);
  },
  title(msg: string): void {
    console.log(chalk.bold.cyan(`\n${msg}\n`));
  },
};
