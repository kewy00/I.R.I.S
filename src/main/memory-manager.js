/**
 * I.R.I.S. Native Markdown Memory & Obsidian Vault Bridge
 * ---------------------------------------------------------------------------
 * Implements a token-efficient 3-tier cognitive memory in plain `.md` files:
 * - Default native path: `d:\I.R.I.S\memory\`
 * - Optional Obsidian Vault path configured via `config/integrations.json`
 * - `MEMORY.md` holds a compact ~150-250 token active index/profile loaded on turns
 * - Additional `.md` notes occupy 0 tokens at rest and are searched/read on demand
 */

const fs = require('fs');
const path = require('path');

const INTEGRATIONS_PATH = path.join(__dirname, '../../config/integrations.json');
const DEFAULT_MEMORY_DIR = path.join(__dirname, '../../memory');
const CORE_MEMORY_FILENAME = 'MEMORY.md';

const INITIAL_MEMORY_TEMPLATE = `# Memoria Activa de I.R.I.S.

## Perfil del Usuario

## Preferencias y Gustos

## Proyectos y Contexto

## Notas Guardadas
`;

function sanitizeFileName(rawTitle) {
  const cleaned = String(rawTitle || 'nota')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || `nota_${Date.now()}`;
}

class IrisMemoryManager {
  constructor() {
    this.ensureInitialized();
  }

  getCustomVaultPath() {
    try {
      if (fs.existsSync(INTEGRATIONS_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf8'));
        const obs = cfg?.obsidian;
        if (obs?.connected && obs?.vaultPath && String(obs.vaultPath).trim()) {
          const candidate = path.resolve(String(obs.vaultPath).trim());
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
          }
        }
      }
    } catch {
      // ignore config read errors and use native dir
    }
    return '';
  }

  getVaultDir() {
    const customVault = this.getCustomVaultPath();
    const targetDir = customVault || DEFAULT_MEMORY_DIR;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return targetDir;
  }

  ensureInitialized() {
    const dir = this.getVaultDir();
    const memoryFile = path.join(dir, CORE_MEMORY_FILENAME);
    if (!fs.existsSync(memoryFile)) {
      fs.writeFileSync(memoryFile, INITIAL_MEMORY_TEMPLATE, 'utf8');
    }
    return memoryFile;
  }

  getStatus() {
    const customVault = this.getCustomVaultPath();
    const activeDir = this.getVaultDir();
    return {
      connected: true,
      isCustomObsidian: Boolean(customVault),
      account: customVault ? 'Obsidian Vault' : 'Nativo (.md)',
      vaultPath: activeDir
    };
  }

  collectMarkdownFiles(dir = this.getVaultDir(), depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectMarkdownFiles(fullPath, depth + 1));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  listNotes() {
    const dir = this.getVaultDir();
    this.ensureInitialized();
    const files = this.collectMarkdownFiles(dir);
    return files.map((filePath) => {
      const fileName = path.relative(dir, filePath).replace(/\\/g, '/');
      let title = path.basename(filePath, '.md');
      try {
        const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)[0] || '';
        if (firstLine.startsWith('#')) {
          title = firstLine.replace(/^#+\s*/, '').trim() || title;
        }
      } catch {
        // fallback to filename
      }
      return { title, fileName, filePath };
    });
  }

  getCoreMemoryContext() {
    const memoryPath = this.ensureInitialized();
    let coreText = '';
    try {
      coreText = fs.readFileSync(memoryPath, 'utf8').trim();
    } catch {
      coreText = INITIAL_MEMORY_TEMPLATE.trim();
    }
    if (coreText.length > 1200) {
      coreText = coreText.slice(0, 1200) + '\n...';
    }

    const otherNotes = this.listNotes()
      .filter((n) => n.fileName !== CORE_MEMORY_FILENAME)
      .slice(0, 20)
      .map((n) => n.fileName);

    const notesIndex =
      otherNotes.length > 0
        ? `\nArchivos .md disponibles en memoria (0 tokens hasta consultarlos): ${otherNotes.join(', ')}`
        : '';

    return `${coreText}${notesIndex}`.trim();
  }

  rememberFact(fact, category = 'Preferencias y Gustos') {
    const cleanFact = String(fact || '').trim().replace(/^[-*]\s*/, '');
    if (!cleanFact) {
      return { ok: false, error: 'Dato vacío para recordar.' };
    }

    const memoryPath = this.ensureInitialized();
    let content = fs.readFileSync(memoryPath, 'utf8');

    const normalizedExisting = content.toLowerCase();
    if (normalizedExisting.includes(cleanFact.toLowerCase())) {
      return {
        ok: true,
        alreadyKnown: true,
        fact: cleanFact,
        filePath: memoryPath
      };
    }

    const validCategories = [
      'Perfil del Usuario',
      'Preferencias y Gustos',
      'Proyectos y Contexto',
      'Notas Guardadas'
    ];
    const matchedCat =
      validCategories.find((c) => c.toLowerCase() === String(category || '').toLowerCase()) ||
      'Preferencias y Gustos';

    const heading = `## ${matchedCat}`;
    const bulletLine = `- ${cleanFact}`;

    if (content.includes(heading)) {
      const idx = content.indexOf(heading) + heading.length;
      content = `${content.slice(0, idx)}\n${bulletLine}${content.slice(idx)}`;
    } else {
      content = `${content.trimEnd()}\n\n${heading}\n${bulletLine}\n`;
    }

    fs.writeFileSync(memoryPath, content, 'utf8');
    return {
      ok: true,
      alreadyKnown: false,
      fact: cleanFact,
      category: matchedCat,
      filePath: memoryPath
    };
  }

  writeNote({ title, content }) {
    const dir = this.getVaultDir();
    this.ensureInitialized();

    const cleanTitle = String(title || '').trim() || 'Nota de IRIS';
    const cleanContent = String(content || '').trim();
    const baseName = sanitizeFileName(cleanTitle);
    const fileName = baseName.toLowerCase().endsWith('.md') ? baseName : `${baseName}.md`;
    const filePath = path.join(dir, fileName);

    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let fileText = '';

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8').trimEnd();
      fileText = `${existing}\n\n---\n_Actualizado: ${timestamp}_\n\n${cleanContent}\n`;
    } else {
      fileText = `# ${cleanTitle}\n\n_Creado: ${timestamp}_\n\n${cleanContent}\n`;
    }

    fs.writeFileSync(filePath, fileText, 'utf8');
    this.rememberFact(`[[${path.basename(fileName, '.md')}]] (${fileName})`, 'Notas Guardadas');

    return {
      ok: true,
      title: cleanTitle,
      fileName,
      filePath,
      snippet: cleanContent.slice(0, 180)
    };
  }

  readNote(titleOrFileName) {
    const dir = this.getVaultDir();
    const target = String(titleOrFileName || '').trim();
    if (!target) {
      return { ok: false, error: 'Nombre o ruta de nota requerido.' };
    }

    const notes = this.listNotes();
    const normTarget = target.toLowerCase().replace(/\.md$/i, '');

    const match =
      notes.find((n) => n.fileName.toLowerCase() === target.toLowerCase()) ||
      notes.find((n) => path.basename(n.fileName, '.md').toLowerCase() === normTarget) ||
      notes.find((n) => n.title.toLowerCase() === normTarget) ||
      notes.find((n) => n.fileName.toLowerCase().includes(normTarget) || n.title.toLowerCase().includes(normTarget));

    const resolvedPath = match ? match.filePath : path.join(dir, `${sanitizeFileName(target)}.md`);
    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, error: `No encontré ninguna nota llamada "${target}".` };
    }

    const raw = fs.readFileSync(resolvedPath, 'utf8');
    return {
      ok: true,
      title: match?.title || path.basename(resolvedPath, '.md'),
      fileName: match?.fileName || path.basename(resolvedPath),
      filePath: resolvedPath,
      content: raw.length > 2000 ? `${raw.slice(0, 2000)}\n...(truncado)` : raw
    };
  }

  searchNotes(query) {
    const dir = this.getVaultDir();
    this.ensureInitialized();
    const q = String(query || '').trim().toLowerCase();
    const notes = this.listNotes();

    if (!q) {
      return {
        ok: true,
        vaultDir: dir,
        matches: notes.slice(0, 5).map((n) => ({
          title: n.title,
          fileName: n.fileName,
          filePath: n.filePath,
          excerpt: 'Archivo Markdown disponible en memoria.'
        }))
      };
    }

    const terms = q.split(/\s+/).filter((t) => t.length >= 2);
    const scored = [];

    for (const note of notes) {
      let text = '';
      try {
        text = fs.readFileSync(note.filePath, 'utf8');
      } catch {
        continue;
      }

      const paragraphs = text
        .split(/\r?\n\s*\r?\n|\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean);

      let bestScore = 0;
      let bestExcerpt = '';

      const nameLower = `${note.title} ${note.fileName}`.toLowerCase();
      for (const term of terms) {
        if (nameLower.includes(term)) bestScore += 3;
      }

      for (const para of paragraphs) {
        const paraLower = para.toLowerCase();
        let paraScore = 0;
        for (const term of terms) {
          if (paraLower.includes(term)) paraScore += 2;
        }
        if (paraLower.includes(q)) paraScore += 4;
        if (paraScore > bestScore || (paraScore > 0 && !bestExcerpt)) {
          bestScore = Math.max(bestScore, paraScore);
          bestExcerpt = para;
        }
      }

      if (bestScore > 0) {
        const excerpt = bestExcerpt || paragraphs[0] || '';
        scored.push({
          score: bestScore,
          title: note.title,
          fileName: note.fileName,
          filePath: note.filePath,
          excerpt: excerpt.length > 200 ? `${excerpt.slice(0, 200)}...` : excerpt
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return {
      ok: true,
      vaultDir: dir,
      matches: scored.slice(0, 3).map(({ score, ...rest }) => rest)
    };
  }
}

const memoryManager = new IrisMemoryManager();

module.exports = {
  memoryManager,
  IrisMemoryManager,
  DEFAULT_MEMORY_DIR
};
