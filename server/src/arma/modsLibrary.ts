import path from "node:path";

/** Default Steam Workshop content dir for Arma 3 (app 107410), under armaRoot. */
export function defaultWorkshopLibrary(armaRoot: string): string {
  const arma = String(armaRoot || "").replace(/[/\\]+$/, "");
  return path.win32.join(arma, "steamapps", "workshop", "content", "107410");
}

/** Resolve host mods library: empty → Steam workshop tree; relative → under armaRoot; else absolute. */
export function resolveModsLibraryPath(armaRoot: string, modsLibraryPath?: string | null): string {
  const arma = String(armaRoot || "").replace(/[/\\]+$/, "");
  const lib = String(modsLibraryPath || "").trim();
  if (!lib) return defaultWorkshopLibrary(arma);
  if (path.win32.isAbsolute(lib) || /^[a-zA-Z]:[\\/]/.test(lib) || lib.startsWith("\\\\")) {
    return lib.replace(/[/\\]+$/, "");
  }
  return path.win32.join(arma, lib);
}

export function isDefaultModsLibrary(armaRoot: string, modsLibraryPath?: string | null): boolean {
  const resolved = path.win32.normalize(resolveModsLibraryPath(armaRoot, modsLibraryPath)).toLowerCase();
  const def = path.win32.normalize(defaultWorkshopLibrary(armaRoot)).toLowerCase();
  return resolved === def;
}

/**
 * Path for -mod= / -serverMod=: relative to armaRoot when under it, otherwise absolute (Windows).
 * Layout: {library}\{workshopId}\
 */
export function modFolderLaunchArg(armaRoot: string, modsLibraryPath: string | null | undefined, workshopId: string): string {
  const arma = String(armaRoot || "").replace(/[/\\]+$/, "");
  const full = path.win32.normalize(path.win32.join(resolveModsLibraryPath(armaRoot, modsLibraryPath), String(workshopId)));
  const armaNorm = path.win32.normalize(arma);
  const prefix = armaNorm.toLowerCase() + path.win32.sep;
  if (full.toLowerCase().startsWith(prefix)) {
    return path.win32.relative(armaNorm, full);
  }
  return full;
}
