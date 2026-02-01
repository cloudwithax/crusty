import { getDatabase, getAsyncDatabase, isUsingPostgres } from "./db.ts";
import { debug } from "../utils/debug.ts";

// database skill record
export interface SkillRecord {
  id: number;
  name: string;
  description: string;
  content: string;
  source_type: "wizard" | "url" | "imported";
  source_url: string | null;
  license: string | null;
  created_at: number;
  updated_at: number;
}

// input for creating a new skill
export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
  sourceType: "wizard" | "url" | "imported";
  sourceUrl?: string;
  license?: string;
}

// save a skill to the database
export async function saveSkill(input: CreateSkillInput): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      // postgres async path
      const existing = await asyncDb.get<{ id: number }>(
        "SELECT id FROM skills WHERE name = ?",
        input.name,
      );

      if (existing) {
        // update existing skill
        await asyncDb.run(
          `UPDATE skills SET 
            description = ?, 
            content = ?, 
            source_type = ?, 
            source_url = ?, 
            license = ?,
            updated_at = EXTRACT(EPOCH FROM NOW())
          WHERE name = ?`,
          [
            input.description,
            input.content,
            input.sourceType,
            input.sourceUrl || null,
            input.license || null,
            input.name,
          ],
        );
        debug(`[skills:db] updated skill: ${input.name}`);
      } else {
        // insert new skill
        await asyncDb.run(
          `INSERT INTO skills (name, description, content, source_type, source_url, license)
          VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.name,
            input.description,
            input.content,
            input.sourceType,
            input.sourceUrl || null,
            input.license || null,
          ],
        );
        debug(`[skills:db] saved new skill: ${input.name}`);
      }
    } else {
      // sqlite sync path
      const db = getDatabase();
      const existingQuery = db.query<{ id: number }>(
        "SELECT id FROM skills WHERE name = ?",
      );
      const existing = existingQuery.get(input.name);

      if (existing) {
        db.run(
          `UPDATE skills SET 
            description = ?, 
            content = ?, 
            source_type = ?, 
            source_url = ?, 
            license = ?,
            updated_at = strftime('%s', 'now')
          WHERE name = ?`,
          [
            input.description,
            input.content,
            input.sourceType,
            input.sourceUrl || null,
            input.license || null,
            input.name,
          ],
        );
        debug(`[skills:db] updated skill: ${input.name}`);
      } else {
        db.run(
          `INSERT INTO skills (name, description, content, source_type, source_url, license)
          VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.name,
            input.description,
            input.content,
            input.sourceType,
            input.sourceUrl || null,
            input.license || null,
          ],
        );
        debug(`[skills:db] saved new skill: ${input.name}`);
      }
    }

    return true;
  } catch (error) {
    debug(`[skills:db] error saving skill ${input.name}:`, error);
    return false;
  }
}

// load all skills from the database
export async function loadAllSkills(): Promise<SkillRecord[]> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      const skills = await asyncDb.all<SkillRecord>(
        "SELECT * FROM skills ORDER BY name",
      );
      debug(`[skills:db] loaded ${skills.length} skill(s) from postgres`);
      return skills;
    } else {
      const db = getDatabase();
      const query = db.query<SkillRecord>("SELECT * FROM skills ORDER BY name");
      const skills = query.all();
      debug(`[skills:db] loaded ${skills.length} skill(s) from sqlite`);
      return skills;
    }
  } catch (error) {
    debug("[skills:db] error loading skills:", error);
    return [];
  }
}

// load a single skill by name
export async function loadSkillByName(
  name: string,
): Promise<SkillRecord | null> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      return await asyncDb.get<SkillRecord>(
        "SELECT * FROM skills WHERE name = ?",
        name,
      );
    } else {
      const db = getDatabase();
      const query = db.query<SkillRecord>(
        "SELECT * FROM skills WHERE name = ?",
      );
      return query.get(name);
    }
  } catch (error) {
    debug(`[skills:db] error loading skill ${name}:`, error);
    return null;
  }
}

// delete a skill by name
export async function deleteSkill(name: string): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      await asyncDb.run("DELETE FROM skills WHERE name = ?", [name]);
    } else {
      const db = getDatabase();
      db.run("DELETE FROM skills WHERE name = ?", [name]);
    }
    debug(`[skills:db] deleted skill: ${name}`);
    return true;
  } catch (error) {
    debug(`[skills:db] error deleting skill ${name}:`, error);
    return false;
  }
}

// check if a skill exists in the database
export async function skillExists(name: string): Promise<boolean> {
  const skill = await loadSkillByName(name);
  return skill !== null;
}
