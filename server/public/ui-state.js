/* Pure view selection; keeps the API snapshot intact. */
globalThis.VillaUI = Object.freeze({
  visibleVillas(villas, { query = '', status = '', sort = 'newest' } = {}) {
    const needle = query.trim().toLocaleLowerCase('de-DE');
    return villas.filter((v) => (!status || v.status === status) &&
      (!needle || `${v.name ?? ''} ${v.idea ?? ''}`.toLocaleLowerCase('de-DE').includes(needle))
    ).sort((a, b) => {
      if (sort === 'name') return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'de', { numeric: true }) || b.id - a.id;
      if (sort === 'status') return String(a.status ?? '').localeCompare(String(b.status ?? '')) || b.id - a.id;
      return b.id - a.id;
    });
  }
});
