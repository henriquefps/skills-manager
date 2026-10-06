/** Does `s` look like a filesystem path (either separator, `C:\x` / `C:/x` drive path, `~/` or `~\`) rather than a bare name? */
export const isPathLike = (s) => /[\\/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s) || s === '~';

/** Starts with the home shorthand, `~/` or `~\`. */
export const isHomeRelative = (s) => s === '~' || s.startsWith('~/') || s.startsWith('~\\');
