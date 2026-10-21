export type Scope = 'company' | 'group' | 'private'
export type ShortcutModifier = 'alt' | 'ctrl'

export type Category = {
  id: string
  name: string
  scope: Scope
  color: string
}

export type VideoAttachment = {
  id: string
  name: string
  mime: string
  size: number
  sha256: string
}

export type Phrase = {
  id: string
  title: string
  text: string
  categoryId: string
  tags: string[]
  images?: string[]
  image?: string
  videos?: VideoAttachment[]
  shortcut?: string
  shortcutModifier?: ShortcutModifier
  favorite?: boolean
  updatedAt: number
}

export type LibraryData = {
  categories: Category[]
  phrases: Phrase[]
}

export type ScopeFilter = 'all' | Scope
