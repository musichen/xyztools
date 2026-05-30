/**
 * Canonical GitHub Release filenames (VSCodium-style, stable across platforms).
 */
export function releaseAssetNames(version) {
  return {
    sourceZip: `XYZTools-${version}-source.zip`,
    macDmg: (arch) => `XYZTools.${arch}.${version}.dmg`,
    winExe: `XYZTools_${version}_x64-setup.exe`,
    winMsi: `XYZTools-${version}-x64.msi`,
    linuxDeb: `xyztools_${version}_amd64.deb`,
    linuxAppImage: `XYZTools-${version}-x86_64.AppImage`,
  };
}

/** Map Tauri bundle filename hints → canonical release name. */
export function mapBundleToReleaseName(filename, version) {
  const lower = filename.toLowerCase();
  const names = releaseAssetNames(version);

  if (lower.endsWith('.dmg')) {
    if (lower.includes('aarch64') || lower.includes('arm64')) {
      return names.macDmg('arm64');
    }
    return names.macDmg('x64');
  }
  if (lower.endsWith('.deb')) return names.linuxDeb;
  if (lower.endsWith('.msi')) return names.winMsi;
  if (lower.endsWith('.exe') && (lower.includes('setup') || lower.includes('nsis'))) {
    return names.winExe;
  }
  if (lower.endsWith('.appimage')) return names.linuxAppImage;

  return null;
}
