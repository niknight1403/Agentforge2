package dev.villaforge.app.core

/**
 * Reiner Textblock-Parser fuer Agentenantworten (v1.14.0): zerlegt
 * Markdown-aehnliche Antworten in typisierte Bloecke, damit der Chat sie
 * strukturiert rendern kann. Bewusst frei von Compose-Abhaengigkeiten:
 * dadurch ohne Emulator unit-testbar.
 */
sealed interface TextBlock {
    data class Heading(val text: String) : TextBlock
    data class Bullet(val text: String) : TextBlock
    data class Numbered(val number: String, val text: String) : TextBlock
    data class Paragraph(val text: String) : TextBlock
}

private val numberedRegex = Regex("^(\\d+)[.)]\\s+(.*)$")

/** Wandelt einen Rohtext in darstellbare Bloecke um; nie leer. */
fun parseTextBlocks(text: String): List<TextBlock> {
    val blocks = mutableListOf<TextBlock>()
    text.split('\n').forEach { raw ->
        val line = raw.trim()
        if (line.isEmpty()) return@forEach
        val match = numberedRegex.find(line)
        when {
            line.startsWith("## ") -> blocks += TextBlock.Heading(line.removePrefix("## ").trim())
            line.startsWith("# ") -> blocks += TextBlock.Heading(line.removePrefix("# ").trim())
            line.startsWith("- ") || line.startsWith("* ") || line.startsWith("• ") ->
                blocks += TextBlock.Bullet(line.drop(2).trim())
            match != null -> blocks += TextBlock.Numbered(match.groupValues[1], match.groupValues[2])
            else -> blocks += TextBlock.Paragraph(line)
        }
    }
    return blocks.ifEmpty { listOf(TextBlock.Paragraph(text)) }
}
