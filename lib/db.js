// シンプルなJSONファイル保存のデータストア。
// 小規模チーム向けの試作用で、
// 本番運用ではデータベース(PostgreSQL など)への
// 置き換えを想定しています。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const COLLECTIONS = ["companies", "contacts", "deals", "meetings"];

export class Store {
  constructor(file) {
    this.file = file;
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    this.data.settings = {};
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const c of COLLECTIONS) this.data[c] = loaded[c] ?? [];
      this.data.settings = loaded.settings ?? {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 書き込み途中で落ちてもファイルが壊れないよう、
    // 一時ファイルに書いてから置き換える
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(col) {
    return this.data[col];
  }

  get(col, id) {
    return this.data[col].find((x) => x.id === id) ?? null;
  }

  insert(col, item) {
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...item };
    this.data[col].push(rec);
    this.save();
    return rec;
  }

  update(col, id, patch) {
    const rec = this.get(col, id);
    if (!rec) return null;
    const { id: _ignore, createdAt: _c, ...rest } = patch;
    Object.assign(rec, rest, { updatedAt: new Date().toISOString() });
    this.save();
    return rec;
  }

  remove(col, id) {
    const before = this.data[col].length;
    this.data[col] = this.data[col].filter((x) => x.id !== id);
    if (col === "companies") {
      // 会社を消したら、ひもづく担当者・商談・議事録も消す
      for (const c of ["contacts", "deals", "meetings"]) {
        this.data[c] = this.data[c].filter((x) => x.companyId !== id);
      }
    }
    if (col === "deals") {
      this.data.meetings = this.data.meetings.filter((x) => x.dealId !== id);
    }
    this.save();
    return this.data[col].length !== before;
  }
}
