// Device-only storage (IndexedDB) for things that must never reach the server: connection names.
import type { Person } from "./match";

const DB = "jobhunter", STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function put(key: string, val: unknown) {
  const db = await open();
  await new Promise<void>((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(val, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
async function get<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error); });
}

// Keyed by user id so two people sharing a computer don't see each other's network.
export const savePeople = (uid: string, people: Person[]) => put(`people:${uid}`, people);
export const loadPeople = async (uid: string) => { try { return (await get<Person[]>(`people:${uid}`)) || []; } catch { return []; } };
export const clearPeople = (uid: string) => put(`people:${uid}`, []);

// Optional Gemini key: kept in this browser only, never sent to our database.
export const ai = {
  key: () => { try { return localStorage.getItem("jh-gemini-key") || ""; } catch { return ""; } },
  model: () => { try { return localStorage.getItem("jh-gemini-model") || "gemini-2.5-flash"; } catch { return "gemini-2.5-flash"; } },
  set: (key: string, model: string) => { try { localStorage.setItem("jh-gemini-key", key); localStorage.setItem("jh-gemini-model", model || "gemini-2.5-flash"); } catch { /* private mode */ } },
};
