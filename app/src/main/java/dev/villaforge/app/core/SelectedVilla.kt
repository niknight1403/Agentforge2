package dev.villaforge.app.core

import androidx.lifecycle.SavedStateHandle

/** The selected project must survive the same process recreation as its screen. */
class SelectedVilla(private val savedState: SavedStateHandle) {
    val id: Long?
        get() = savedState.get<Long>(KEY)?.takeIf { it > 0 }

    fun select(id: Long) {
        require(id > 0) { "Villa-ID muss positiv sein" }
        savedState[KEY] = id
    }

    fun clear() {
        savedState.remove<Long>(KEY)
    }

    companion object {
        const val KEY = "selectedVillaId"
    }
}
