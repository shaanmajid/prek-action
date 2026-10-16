export type Table = Record<string, unknown>

export function table(value: unknown): Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Table)
    : {}
}

export function unique(values: string[], source: string): string {
  const versions = [...new Set(values)]
  if (versions.length === 0) throw new Error(`No prek version found in ${source}`)
  if (versions.length > 1) {
    throw new Error(
      `Ambiguous prek versions or constraints in ${source}: ${versions.join(', ')}. Set version explicitly.`,
    )
  }
  return versions[0]
}

export function unsupportedSource(source: string): never {
  throw new Error(
    `Unsupported prek source in ${source}. version-file selects an official prek release; set version explicitly for the release you want.`,
  )
}
