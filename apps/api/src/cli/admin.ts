import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { openDatabase, runMigrations } from '../db/client.js';
import {
  ADMIN_ROLES,
  AccountConflictError,
  AccountNotFoundError,
  type AdminRole,
} from '../modules/auth/accounts.js';
import {
  createAdminAccount,
  disableAdminAccount,
  listAdminAccounts,
  PasswordPolicyError,
  resetAdminPassword,
} from '../modules/auth/admin-operations.js';

const USAGE = `Benefit Hub 管理员账号工具

用法（密码只从标准输入读取，不接受命令行参数或环境变量）：
  node dist/cli/admin.js create --username <账号> [--role admin|viewer] [--display-name <名称>] --password-stdin
  node dist/cli/admin.js reset-password --username <账号> --password-stdin
  node dist/cli/admin.js disable --username <账号>
  node dist/cli/admin.js list

示例（密码不进入 shell 历史或进程参数）：
  read -rs NEW_PASSWORD
  printf '%s' "$NEW_PASSWORD" | node dist/cli/admin.js reset-password --username ops --password-stdin
`;

class CliError extends Error {}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError('请通过管道提供密码，不要在交互终端直接输入；见 --help');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const password = raw.replace(/\r?\n$/, '');
  if (password.includes('\n') || password.includes('\r')) {
    throw new CliError('密码不能包含换行符');
  }
  return password;
}

function parseRole(value: string | undefined): AdminRole {
  if (value === undefined) return 'admin';
  if ((ADMIN_ROLES as readonly string[]).includes(value)) return value as AdminRole;
  throw new CliError('--role 只支持 admin 或 viewer');
}

function requireUsername(value: string | undefined): string {
  if (!value) throw new CliError('缺少 --username');
  return value;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      username: { type: 'string' },
      role: { type: 'string' },
      'display-name': { type: 'string' },
      'password-stdin': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    if (!command && !values.help) process.exitCode = 2;
    return;
  }

  const config = loadConfig(process.env);
  const database = openDatabase(config.databaseFile);
  try {
    runMigrations(database.sqlite);

    switch (command) {
      case 'create': {
        const password = await readPasswordFromStdin();
        const account = await createAdminAccount(database.db, {
          username: requireUsername(values.username),
          password,
          role: parseRole(values.role),
          displayName: values['display-name'],
        });
        process.stdout.write(`已创建管理员账号 ${account.username}（角色 ${account.role}）\n`);
        break;
      }
      case 'reset-password': {
        const password = await readPasswordFromStdin();
        await resetAdminPassword(database.db, requireUsername(values.username), password);
        process.stdout.write('密码已重置，已撤销该账号的全部现有会话\n');
        break;
      }
      case 'disable': {
        disableAdminAccount(database.db, requireUsername(values.username));
        process.stdout.write('账号已停用，现有会话已撤销\n');
        break;
      }
      case 'list': {
        const accounts = listAdminAccounts(database.db);
        if (accounts.length === 0) {
          process.stdout.write('暂无管理员账号\n');
          break;
        }
        for (const account of accounts) {
          const status = account.disabled ? 'disabled' : 'active';
          const createdAt = new Date(account.createdAt).toISOString();
          process.stdout.write(`${account.username}\t${account.role}\t${status}\t${createdAt}\n`);
        }
        break;
      }
      default:
        throw new CliError(`未知命令：${command}`);
    }
  } finally {
    database.close();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    if (error instanceof CliError || error instanceof PasswordPolicyError) {
      process.stderr.write(`错误：${error.message}\n`);
    } else if (error instanceof AccountConflictError || error instanceof AccountNotFoundError) {
      process.stderr.write(`错误：${error.message}\n`);
    } else {
      process.stderr.write('错误：管理员操作失败，请检查 DATABASE_FILE 与数据库权限\n');
    }
    process.exitCode = 1;
  });
}
