package dev.villaforge.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class VillaEventTest {
    @Test
    fun sanitizedTaskEventShowsItsTaskIdWhenTitleIsHidden() {
        val event = VillaEvent.parse(
            """{"type":"task","ts":1,"villaId":5,"taskId":42,"status":"RUNNING"}"""
        )

        assertNotNull(event)
        assertEquals("Aufgabe #42 → RUNNING", event?.text)
    }

    @Test
    fun taskEventKeepsItsTitleWhenOneIsAvailable() {
        val event = VillaEvent.parse(
            """{"type":"task","ts":1,"villaId":5,"taskId":42,"title":"Build Web-App","status":"DONE"}"""
        )

        assertEquals("Aufgabe „Build Web-App“ → DONE", event?.text)
    }
}
