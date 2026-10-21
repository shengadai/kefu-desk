import type { Category, LibraryData, Phrase } from './types'

export type JsonImportCandidate = {
  sourceIndex: number
  phrase: Phrase
  category: Category
  existingPhrase?: Phrase
}

export type JsonImportPreview = {
  candidates: JsonImportCandidate[]
  existingDuplicates: number
  fileDuplicates: number
  emptyPhrases: number
}

function normalizedText(value: string) {
  return value.replace(/\r\n?/g, '\n').trim()
}

function imagesOf(phrase: Phrase) {
  return phrase.images?.length ? phrase.images : phrase.image ? [phrase.image] : []
}

function contentKey(phrase: Phrase) {
  return JSON.stringify([normalizedText(phrase.title), normalizedText(phrase.text), imagesOf(phrase)])
}

function normalizedCategory(category: Category): Category {
  return {
    id: category.id,
    name: category.name.trim() || '导入分类',
    scope: category.scope === 'company' || category.scope === 'group' ? category.scope : 'private',
    color: typeof category.color === 'string' && category.color ? category.color : '#758b9d',
  }
}

function categoryKey(category: Category) {
  const normalized = normalizedCategory(category)
  return JSON.stringify([normalized.scope, normalized.name])
}

export function buildJsonImportPreview(current: LibraryData, incoming: LibraryData): JsonImportPreview {
  const existingKeys = new Set(current.phrases.map(contentKey))
  const seenKeys = new Set<string>()
  const existingById = new Map(current.phrases.map((phrase) => [phrase.id, phrase]))
  const existingByTitle = new Map(current.phrases.filter((phrase) => normalizedText(phrase.title)).map((phrase) => [normalizedText(phrase.title), phrase]))
  const categories = new Map(incoming.categories.map((category) => [category.id, normalizedCategory(category)]))
  const preview: JsonImportPreview = { candidates: [], existingDuplicates: 0, fileDuplicates: 0, emptyPhrases: 0 }
  incoming.phrases.forEach((phrase, sourceIndex) => {
    const category = categories.get(phrase.categoryId)
    if (!category || (!phrase.text.trim() && imagesOf(phrase).length === 0)) {
      preview.emptyPhrases += 1
      return
    }
    const key = contentKey(phrase)
    if (existingKeys.has(key)) {
      preview.existingDuplicates += 1
      return
    }
    if (seenKeys.has(key)) {
      preview.fileDuplicates += 1
      return
    }
    seenKeys.add(key)
    const { videos: _videos, ...importablePhrase } = phrase
    preview.candidates.push({
      sourceIndex,
      phrase: importablePhrase,
      category,
      existingPhrase: existingById.get(phrase.id) ?? existingByTitle.get(normalizedText(phrase.title)),
    })
  })
  return preview
}

export function mergeJsonImport(current: LibraryData, incoming: LibraryData, selectedIndices: number[]) {
  const selected = new Set(selectedIndices)
  const candidates = buildJsonImportPreview(current, incoming).candidates.filter((candidate) => selected.has(candidate.sourceIndex))
  if (!candidates.length) return { library: current, addedCount: 0, categoryCount: 0 }
  const categories = [...current.categories]
  const phrases = [...current.phrases]
  const categoriesByKey = new Map(categories.map((category) => [categoryKey(category), category]))
  const categoryIds = new Set(categories.map((category) => category.id))
  const phraseIds = new Set(phrases.map((phrase) => phrase.id))
  const allocateId = (preferred: string, used: Set<string>) => {
    let id = preferred
    while (!id || used.has(id)) id = `import-${crypto.randomUUID()}`
    used.add(id)
    return id
  }
  for (const candidate of candidates) {
    const key = categoryKey(candidate.category)
    let category = categoriesByKey.get(key)
    if (!category) {
      category = { ...candidate.category, id: allocateId(candidate.category.id, categoryIds) }
      categories.push(category)
      categoriesByKey.set(key, category)
    }
    phrases.push({ ...candidate.phrase, id: allocateId(candidate.phrase.id, phraseIds), categoryId: category.id })
  }
  return { library: { categories, phrases }, addedCount: candidates.length, categoryCount: categories.length - current.categories.length }
}
