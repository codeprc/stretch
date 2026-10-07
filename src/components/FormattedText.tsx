import type { ReactNode } from 'react'

interface FormattedTextProps {
  text: string
}

export function FormattedText({ text }: FormattedTextProps) {
  const formattedText = /(["'])([^"'\r\n]+)\1|([‘“])([^’”\r\n]+)([’”])|([’”])([^‘“\r\n]+)([’”])|(\d+)(st|nd|rd|th)\b/gi
  const parts: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = formattedText.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    if (match[1] !== undefined) {
      parts.push(<sup className="formatted-text-superscript" key={`sup-${match.index}`}>{match[2]}</sup>)
    } else if (match[3] !== undefined) {
      parts.push(<sup className="formatted-text-superscript" key={`sup-${match.index}`}>{match[4]}</sup>)
    } else if (match[6] !== undefined) {
      parts.push(<sup className="formatted-text-superscript" key={`sup-${match.index}`}>{match[7]}</sup>)
    } else {
      parts.push(match[9], <sup className="formatted-text-superscript" key={`sup-${match.index}`}>{match[10]}</sup>)
    }
    cursor = match.index + match[0].length
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}