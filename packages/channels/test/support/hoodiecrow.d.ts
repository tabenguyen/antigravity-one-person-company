// hoodiecrow-imap ships no types. Only the surface the test harness touches is declared.
declare module "hoodiecrow-imap" {
  export interface HoodiecrowMessage {
    raw: string;
    uid: number;
    flags: string[];
    internaldate: string;
  }
  export interface HoodiecrowMailbox {
    path: string;
    uidvalidity: number;
    uidnext: number;
    messages: HoodiecrowMessage[];
    flags: string[];
  }
  export interface HoodiecrowConnection {
    socket: { destroy(): void; destroyed: boolean } | null;
  }
  export interface HoodiecrowServer {
    server: import("node:net").Server;
    folderCache: Record<string, HoodiecrowMailbox>;
    connectionHandlers: Array<(conn: HoodiecrowConnection) => void>;
    getCommandHandler(command: string): (...args: unknown[]) => unknown;
    appendMessage(
      mailbox: string | HoodiecrowMailbox,
      flags: string[],
      internaldate: string | Date | undefined,
      raw: string,
    ): { mailbox: HoodiecrowMailbox; message: HoodiecrowMessage };
    listen(port: number, host: string, cb?: () => void): void;
    close(cb?: () => void): void;
  }
  export default function hoodiecrow(options?: Record<string, unknown>): HoodiecrowServer;
}
