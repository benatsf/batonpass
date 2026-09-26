export interface Cursor {
  path: string;
  inode: number;
  offset: number;
  size: number;
  mtimeMs: number;
  /** True when the previous read stopped inside an over-long line that must still be skipped. */
  skipping?: boolean;
}
