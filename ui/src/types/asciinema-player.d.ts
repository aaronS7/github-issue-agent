import 'asciinema-player';

// The player emits this documented event since 3.16; 3.17's types omit it.
declare module 'asciinema-player' {
  interface Player {
    addEventListener(eventName: 'error', handler: (this: Player) => void): void;
  }
}
