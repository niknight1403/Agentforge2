package dev.villaforge.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit-Tests fuer den Textblock-Parser (v1.14.0). Der Parser ist bewusst
 * frei von Android-Abhaengigkeiten, damit er ohne Emulator laeuft.
 */
class TextBlocksTest {

    @Test
    fun `leerer Text liefert einen Absatz`() {
        val blocks = parseTextBlocks("")
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is TextBlock.Paragraph)
    }

    @Test
    fun `Ueberschriften mit # und ## werden erkannt`() {
        val blocks = parseTextBlocks("# Titel\n## Abschnitt")
        assertEquals(2, blocks.size)
        assertEquals(TextBlock.Heading("Titel"), blocks[0])
        assertEquals(TextBlock.Heading("Abschnitt"), blocks[1])
    }

    @Test
    fun `Listen mit Punkt Stern und Bullet werden Bullet-Bloecke`() {
        val blocks = parseTextBlocks("- eins\n* zwei\n• drei")
        assertEquals(3, blocks.size)
        assertEquals(TextBlock.Bullet("eins"), blocks[0])
        assertEquals(TextBlock.Bullet("zwei"), blocks[1])
        assertEquals(TextBlock.Bullet("drei"), blocks[2])
    }

    @Test
    fun `nummerierte Listen mit Punkt und Klammer werden erkannt`() {
        val blocks = parseTextBlocks("1. Schritt\n2) Zweiter")
        assertEquals(TextBlock.Numbered("1", "Schritt"), blocks[0])
        assertEquals(TextBlock.Numbered("2", "Zweiter"), blocks[1])
    }

    @Test
    fun `Leerzeilen werden uebersprungen`() {
        val blocks = parseTextBlocks("Zeile A\n\n   \nZeile B")
        assertEquals(2, blocks.size)
        assertEquals(TextBlock.Paragraph("Zeile A"), blocks[0])
        assertEquals(TextBlock.Paragraph("Zeile B"), blocks[1])
    }

    @Test
    fun `Mischtext behaelt die Reihenfolge bei`() {
        val text = "## Plan\n1. Bauen\n2. Pruefen\n- Notiz\nRest\n\n"
        val blocks = parseTextBlocks(text)
        assertEquals(5, blocks.size)
        assertTrue(blocks[0] is TextBlock.Heading)
        assertTrue(blocks[1] is TextBlock.Numbered)
        assertTrue(blocks[2] is TextBlock.Numbered)
        assertTrue(blocks[3] is TextBlock.Bullet)
        assertTrue(blocks[4] is TextBlock.Paragraph)
    }
}
