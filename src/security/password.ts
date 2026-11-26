import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** The library's const enum cannot be imported under isolatedModules. 2 is Argon2id. */
const ARGON2ID = 2 as Algorithm;

export interface Argon2Settings {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** A small embedded list. Passwords are compared lowercased, with trailing digits and symbols removed. */
const COMMON = new Set([
  'password',
  'passwordpassword',
  'password123456',
  'passw0rdpassw0rd',
  'qwertyuiopas',
  'qwertyuiop',
  'qwertyuiopasdf',
  'qwertyuiopasdfgh',
  'asdfghjklqwer',
  'asdfghjkl',
  'zxcvbnmasdfgh',
  'iloveyou',
  'iloveyouiloveyou',
  'letmeinletmein',
  'welcomewelcome',
  'administrator',
  'administrator123',
  'adminadminadmin',
  'adminpassword',
  'changemechangeme',
  'changemenow',
  'trustno1trustno1',
  'monkeymonkey',
  'dragondragon',
  'footballfootball',
  'baseballbaseball',
  'superman1234',
  'sunshinesunshine',
  'princessprincess',
  'whateverwhatever',
  'mypasswordis',
  'correcthorsebatterystaple',
  'abcdefghijkl',
  'abcdefghijklmnop',
  'abcdefghijklmnopqrstuvwxyz',
  'thequickbrownfox',
  'internationalization',
  'allovityallovity',
  'allovitypassword',
  'welcometoallovity',
  'unknownunknown',
  'testingtesting',
  'testtesttesttest',
  'masterpassword',
  'defaultpassword',
  'temporarypassword',
  'temppasswordtemp',
]);

export interface PolicyContext {
  email?: string;
  displayName?: string;
}

/** Returns a plain-language problem, or null when the password is acceptable. */
export function passwordProblem(password: string, context: PolicyContext = {}): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use no more than ${PASSWORD_MAX} characters.`;
  const lowered = password.toLowerCase();

  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split('@')[0] ?? '';
    if (lowered.includes(email) || (local.length >= 4 && lowered.includes(local))) {
      return 'The password must not contain your email address.';
    }
  }
  const nameParts = (context.displayName ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 4);
  if (nameParts.some((part) => lowered.includes(part))) {
    return 'The password must not contain your name.';
  }

  const stripped = lowered.replace(/[\d\W_]+$/u, '');
  if (COMMON.has(lowered) || COMMON.has(stripped)) {
    return 'That password is too common. Choose something less predictable.';
  }
  if (new Set(lowered).size < 5) return 'That password has too little variety.';
  return null;
}

export class PasswordHasher {
  private readonly options: {
    algorithm: Algorithm;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  private dummy: Promise<string> | undefined;

  constructor(settings: Argon2Settings) {
    this.options = { algorithm: ARGON2ID, ...settings };
  }

  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  async verify(encoded: string, password: string): Promise<boolean> {
    try {
      return await verify(encoded, password);
    } catch {
      return false;
    }
  }

  /**
   * Hash used when the account does not exist, is inactive or the attempt is throttled,
   * so those paths cost as much time as a real check. Built once with the same settings.
   */
  dummyHash(): Promise<string> {
    this.dummy ??= this.hash('dummy-password-for-timing-only');
    return this.dummy;
  }

  async spendTime(password: string): Promise<void> {
    await this.verify(await this.dummyHash(), password);
  }
}
