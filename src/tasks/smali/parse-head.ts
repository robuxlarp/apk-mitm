/**
 * Parse the "head" of a Smali file to extract basic metadata that other
 * patches rely on (class name, whether it's an interface, super class,
 * and implemented interfaces).
 *
 * The implementation keeps the parsing conservative and resilient to
 * slightly different smali styles. It avoids using `matchAll` without
 * an explicit cast so TypeScript understands the result shape.
 */

export type SmaliHead = {
  name: string
  isInterface: boolean
  super?: string
  implements: string[]
}

export default function parseSmaliHead(contents: string): SmaliHead {
  // Normalize line endings and split once (fast and simple)
  const lines = contents.replace(/\r\n/g, '\n').split('\n')

  // Find the .class line. Examples:
  //   .class public Lcom/example/MyClass;
  //   .class public interface Lcom/example/MyInterface;
  const classLine = lines.find(line => line.trim().startsWith('.class '))

  let name = ''
  let isInterface = false

  if (classLine) {
    const trimmed = classLine.trim()
    isInterface = /\binterface\b/.test(trimmed)

    // The class name is typically the last token on the line:
    // .class <flags> <name>
    const parts = trimmed.split(/\s+/)
    const lastToken = parts[parts.length - 1] || ''
    // Remove optional trailing semicolon (some smali variants include it)
    name = lastToken.replace(/;$/, '')
  }

  // Find the .super line (e.g. ".super Ljava/lang/Object;")
  const superLine = lines.find(line => line.trim().startsWith('.super '))
  let superName: string | undefined = undefined
  if (superLine) {
    const t = superLine.trim().split(/\s+/)
    if (t.length >= 2) {
      superName = t[1].replace(/;$/, '')
    }
  }

  // Collect all .implements lines. There can be multiple.
  // Use matchAll but cast it so TypeScript knows the iterator item type.
  const IMPLEMENTS_RE = /^\.implements\s+(\S+)/gm
  const implementsMatches = Array.from(
    (contents.matchAll(IMPLEMENTS_RE) as Iterable<RegExpMatchArray>) || [],
  ).map((m: RegExpMatchArray) => {
    // m[1] holds the implemented interface name
    return (m[1] || '').replace(/;$/, '')
  })

  return {
    name,
    isInterface,
    super: superName,
    implements: implementsMatches,
  }
}
