import { describe, expect, it } from "vitest";
import { CHAT_KEY, clearChat, loadChat, saveChat } from "../chatStore.js";

function memoryStorage({ limit = Infinity } = {}) {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (String(value).length > limit) throw new Error("QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key)
  };
}

const chat = [
  { id: "u1", role: "user", text: "hello", images: [{ id: "i1", name: "a.png", dataUrl: "data:image/png;base64,AAAA", data: "AAAA", mimeType: "image/png" }] },
  { id: "a1", role: "assistant", text: "hi there", pending: false }
];

describe("playground chat persistence", () => {
  it("restores the conversation after a reload", () => {
    const storage = memoryStorage();
    expect(saveChat(chat, storage)).toBe("saved");
    const restored = loadChat(storage);
    expect(restored.map((m) => m.text)).toEqual(["hello", "hi there"]);
    expect(restored[0].images[0].dataUrl).toContain("data:image/png");
    // The raw upload copy is not stored twice.
    expect(storage.getItem(CHAT_KEY)).not.toContain('"mimeType"');
  });

  it("never restores a reply as still streaming", () => {
    const storage = memoryStorage();
    storage.setItem(CHAT_KEY, JSON.stringify([{ id: "a", role: "assistant", text: "half", pending: true }]));
    expect(loadChat(storage)[0].pending).toBe(false);
  });

  it("clearing (an empty chat) removes the saved copy", () => {
    const storage = memoryStorage();
    saveChat(chat, storage);
    saveChat([], storage);
    expect(storage.getItem(CHAT_KEY)).toBeNull();
    saveChat(chat, storage);
    clearChat(storage);
    expect(loadChat(storage)).toEqual([]);
  });

  it("keeps the text and drops images when storage is nearly full", () => {
    const storage = memoryStorage({ limit: 300 });
    const big = [{ ...chat[0], images: [{ id: "i", name: "b.png", dataUrl: `data:image/png;base64,${"A".repeat(2000)}` }] }, chat[1]];
    expect(saveChat(big, storage)).toBe("saved-without-images");
    const restored = loadChat(storage);
    expect(restored[0].images).toBeUndefined();
    expect(restored[0].imageCount).toBe(1);
    expect(restored[1].text).toBe("hi there");
  });

  it("ignores corrupt or foreign data", () => {
    const storage = memoryStorage();
    storage.setItem(CHAT_KEY, "{not json");
    expect(loadChat(storage)).toEqual([]);
    storage.setItem(CHAT_KEY, JSON.stringify([{ role: "system", id: "x", text: "no" }, 5, null]));
    expect(loadChat(storage)).toEqual([]);
    expect(loadChat(null)).toEqual([]);
  });
});
