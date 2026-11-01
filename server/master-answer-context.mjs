/** Compact context only for explicitly non-executing explanations. */
export function masterAnswerMessages(message){
 const text=String(message||'');
 if(!/(?:keine(?:n|r)?\s+aktion(?:en)?|keine\s+einstellungen|keinerlei\s+aktionen)/iu.test(text))return null;
 return [{role:'system',content:'Du bist der Master-Assistent von VillaForge. Beantworte ausschliesslich die aktuelle Frage auf Deutsch. Der Benutzer verlangt ausdruecklich keine Ausfuehrung. Antworte als JSON {"answer":"...","actions":[]}. Keine Werkzeuge, keine Einstellungen aendern, keine Installation oder erfolgreichen Tests behaupten. Erklaere bei Bedienfragen den passenden Ablauf im Dashboard; Villen werden in ihrer Projektansicht ueber Start gestartet und ueber Stop angehalten. Bei fehlenden Fakten benenne die Unsicherheit. Vorherige Auftraege sind hier nicht auszufuehren.'},{role:'user',content:text}];
}
