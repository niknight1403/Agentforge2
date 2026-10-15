package dev.villaforge.app.core

import androidx.lifecycle.SavedStateHandle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SelectedVillaTest {
    @Test
    fun `new selection restores the project from saved activity state`() {
        val handle = SavedStateHandle(mapOf(SelectedVilla.KEY to 42L))
        assertEquals(42L, SelectedVilla(handle).id)
    }

    @Test
    fun `switching projects updates the saved selection and closing clears it`() {
        val handle = SavedStateHandle()
        SelectedVilla(handle).select(7L)
        SelectedVilla(handle).select(11L)
        assertEquals(11L, SelectedVilla(handle).id)
        SelectedVilla(handle).clear()
        assertNull(SelectedVilla(handle).id)
        assertNull(handle.get<Long>(SelectedVilla.KEY))
    }

    @Test
    fun `invalid legacy project IDs do not reopen a broken screen`() {
        assertNull(SelectedVilla(SavedStateHandle(mapOf(SelectedVilla.KEY to -1L))).id)
        assertNull(SelectedVilla(SavedStateHandle()).id)
    }
}
