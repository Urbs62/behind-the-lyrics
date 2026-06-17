const DATA_URL = "songs.json";
const CACHE_KEY = "behindTheLyrics.libraryCache.v3";
const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

const state = {
  library: createEmptyLibrary(),
  search: "",
  openArtists: new Set(),
  openAlbums: new Set(),
  visibleInterpretations: new Set(),
  editingInterpretations: new Set(),
  generatingInterpretations: new Set(),
  operationStatus: "",
  loadedFrom: "memory",
  fileHandle: null,
  hasUnsavedChanges: false
};

const fileInput = document.querySelector("#fileInput");
const searchInput = document.querySelector("#searchInput");
const openJsonButton = document.querySelector("#openJsonButton");
const saveJsonButton = document.querySelector("#saveJsonButton");
const exportButton = document.querySelector("#exportButton");
const clearButton = document.querySelector("#clearButton");
const libraryElement = document.querySelector("#library");
const statusText = document.querySelector("#statusText");

init();

async function init() {
  fileInput.addEventListener("change", handleFileImport);
  searchInput.addEventListener("input", handleSearch);
  openJsonButton.addEventListener("click", openJsonFile);
  saveJsonButton.addEventListener("click", saveLibraryToMasterFile);
  exportButton.addEventListener("click", exportLibrary);
  clearButton.addEventListener("click", clearLibrary);
  libraryElement.addEventListener("click", handleLibraryClick);

  await loadInitialLibrary();
  render();
}

async function loadInitialLibrary() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Could not load ${DATA_URL}: ${response.status}`);
    }

    const json = await response.json();
    state.library = normalizeLibrary(json);
    state.loadedFrom = DATA_URL;
    state.hasUnsavedChanges = false;
    cacheLibrary();
    setStatus(`Loaded ${getSongCount(state.library)} songs from songs.json.`);
  } catch (error) {
    console.warn(error);
    const cachedLibrary = loadCachedLibrary();

    if (cachedLibrary) {
      state.library = cachedLibrary;
      state.loadedFrom = "temporary cache";
      state.hasUnsavedChanges = true;
      setStatus("songs.json could not be loaded locally. Showing temporary cached data.");
      return;
    }

    state.library = createEmptyLibrary();
    state.loadedFrom = "empty";
    state.hasUnsavedChanges = false;
    setStatus("songs.json could not be loaded. Import a CSV/M3U file, then export songs.json.");
  }
}

async function openJsonFile() {
  if (!window.showOpenFilePicker) {
    setStatus("Direct file editing needs a Chromium browser. Use Download copy as fallback.");
    return;
  }

  try {
    const [fileHandle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "songs.json",
          accept: {
            "application/json": [".json"]
          }
        }
      ]
    });
    const file = await fileHandle.getFile();
    const text = await file.text();

    state.library = normalizeLibrary(JSON.parse(text));
    state.fileHandle = fileHandle;
    state.loadedFrom = file.name;
    state.hasUnsavedChanges = false;
    cacheLibrary();
    render();
    setStatus(`Admin mode connected to ${file.name}. Imports and interpretations can now save directly.`);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      setStatus("Could not open songs.json. Check that the file is valid JSON.");
    }
  }
}

async function handleFileImport(event) {
  const file = event.target.files[0];

  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const importedSongs = parseImport(text, file.name);

    if (!importedSongs.length) {
      setStatus("The file was read, but no songs were found.");
      return;
    }

    state.library = mergeSongsIntoLibrary(state.library, importedSongs);
    state.openArtists = new Set(importedSongs.map((song) => song.artist));
    state.openAlbums = new Set(importedSongs.map((song) => getAlbumKey(song.artist, song.album)));
    cacheLibrary();
    await persistLibraryChange();
    render();
    setStatus(`Imported ${importedSongs.length} songs. ${getPersistenceHint()}`);
  } catch (error) {
    console.error(error);
    setStatus("Import failed. Check the file format and try again.");
  } finally {
    fileInput.value = "";
  }
}

function handleSearch(event) {
  state.search = event.target.value.trim().toLowerCase();
  render();
}

async function handleLibraryClick(event) {
  const generateButton = event.target.closest("[data-generate-real]");

  if (!generateButton || !libraryElement.contains(generateButton)) {
    return;
  }

  event.preventDefault();

  if (generateButton.disabled) {
    return;
  }

  await handleGenerateInterpretation(
    generateButton.dataset.artistName,
    generateButton.dataset.albumName,
    generateButton.dataset.songTitle
  );
}

async function clearLibrary() {
  state.library = createEmptyLibrary();
  state.openArtists.clear();
  state.openAlbums.clear();
  state.visibleInterpretations.clear();
  state.editingInterpretations.clear();
  localStorage.removeItem(CACHE_KEY);
  state.hasUnsavedChanges = true;
  await persistLibraryChange();
  render();
  setStatus(`Local working library cleared. ${getPersistenceHint()}`);
}

async function saveLibraryToMasterFile() {
  if (!state.fileHandle) {
    await saveLibraryWithPicker();
    return;
  }

  await writeLibraryToFileHandle(state.fileHandle);
  state.hasUnsavedChanges = false;
  state.loadedFrom = state.fileHandle.name || "songs.json";
  cacheLibrary();
  render();
  setStatus("songs.json saved. Remaining manual step: commit and push to GitHub.");
}

async function saveLibraryWithPicker() {
  if (!window.showSaveFilePicker) {
    exportLibrary();
    setStatus("Direct save is not available in this browser. Downloaded a songs.json copy instead.");
    return;
  }

  try {
    const fileHandle = await window.showSaveFilePicker({
      suggestedName: "songs.json",
      types: [
        {
          description: "songs.json",
          accept: {
            "application/json": [".json"]
          }
        }
      ]
    });

    state.fileHandle = fileHandle;
    await saveLibraryToMasterFile();
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error(error);
      setStatus("Could not save songs.json.");
    }
  }
}

async function persistLibraryChange() {
  state.hasUnsavedChanges = true;
  cacheLibrary();

  if (!state.fileHandle) {
    return false;
  }

  try {
    await writeLibraryToFileHandle(state.fileHandle);
    state.hasUnsavedChanges = false;
    return true;
  } catch (error) {
    console.error(error);
    setStatus("Could not write to songs.json. Use Save songs.json or Download copy.");
    return false;
  }
}

async function writeLibraryToFileHandle(fileHandle) {
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(sortLibrary(state.library), null, 2)}\n`);
  await writable.close();
}

function exportLibrary() {
  const json = JSON.stringify(sortLibrary(state.library), null, 2);
  const blob = new Blob([`${json}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "songs.json";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Exported the complete library as songs.json.");
}

function parseImport(text, fileName) {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".m3u") || lowerName.endsWith(".m3u8") || text.trimStart().startsWith("#EXTM3U")) {
    return parseM3u(text);
  }

  return parseCsv(text);
}

function parseCsv(text) {
  const rows = parseCsvRows(text);

  if (!rows.length) {
    return [];
  }

  const header = rows[0].map((column) => column.trim().toLowerCase());
  const artistIndex = header.indexOf("artist");
  const albumIndex = header.indexOf("album");
  const titleIndex = header.indexOf("title");

  if (artistIndex === -1 || albumIndex === -1 || titleIndex === -1) {
    return [];
  }

  return rows
    .slice(1)
    .map((row) => normalizeImportedSong({
      artist: row[artistIndex],
      album: row[albumIndex],
      title: row[titleIndex]
    }))
    .filter(Boolean);
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      row.push(value);
      if (row.some((column) => column.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  row.push(value);
  if (row.some((column) => column.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function parseM3u(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const songs = [];
  let pendingExtinf = null;

  lines.forEach((line) => {
    if (line.startsWith("#EXTINF:")) {
      pendingExtinf = parseExtinf(line);
      return;
    }

    if (line.startsWith("#")) {
      return;
    }

    const pathInfo = parsePathInfo(line);
    songs.push(normalizeImportedSong({
      artist: pendingExtinf?.artist || pathInfo.artist,
      album: pathInfo.album || "Unknown Album",
      title: pendingExtinf?.title || pathInfo.title
    }));
    pendingExtinf = null;
  });

  return songs.filter(Boolean);
}

function parseExtinf(line) {
  const commaIndex = line.indexOf(",");
  const metadata = commaIndex === -1 ? "" : line.slice(commaIndex + 1).trim();
  const separator = metadata.indexOf(" - ");

  if (separator === -1) {
    return {
      artist: "",
      title: metadata
    };
  }

  return {
    artist: metadata.slice(0, separator).trim(),
    title: metadata.slice(separator + 3).trim()
  };
}

function parsePathInfo(path) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const fileName = parts.at(-1) || "";
  const albumFolder = parts.at(-2) || "";
  const artistFolder = parts.at(-3) || "";
  const cleanFileName = stripTrackNumber(stripExtension(fileName));
  const album = cleanAlbumName(albumFolder);
  const titleParts = cleanFileName.split(" - ").map((part) => part.trim()).filter(Boolean);

  if (titleParts.length >= 2) {
    return {
      artist: artistFolder || titleParts[0],
      album,
      title: titleParts.slice(1).join(" - ")
    };
  }

  return {
    artist: artistFolder,
    album,
    title: cleanFileName
  };
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}

function stripTrackNumber(value) {
  return value
    .replace(/^\d+\s*[-_.]\s*/, "")
    .replace(/^\d+\s+/, "")
    .trim();
}

function cleanAlbumName(folderName) {
  return folderName
    .replace(/^\d{4}\s*[-_.]\s*/, "")
    .trim() || "Unknown Album";
}

function mergeSongsIntoLibrary(library, importedSongs) {
  const nextLibrary = normalizeLibrary(library);

  importedSongs.forEach((importedSong) => {
    const artist = getOrCreateArtist(nextLibrary, importedSong.artist);
    const album = getOrCreateAlbum(artist, importedSong.album);
    const existingSong = album.songs.find((song) => song.title.toLowerCase() === importedSong.title.toLowerCase());

    if (!existingSong) {
      album.songs.push(createSong(importedSong.title));
    }
  });

  return sortLibrary(nextLibrary);
}

function getOrCreateArtist(library, artistName) {
  let artist = library.artists.find((item) => item.name.toLowerCase() === artistName.toLowerCase());

  if (!artist) {
    artist = {
      name: artistName,
      albums: []
    };
    library.artists.push(artist);
  }

  return artist;
}

function getOrCreateAlbum(artist, albumName) {
  let album = artist.albums.find((item) => item.name.toLowerCase() === albumName.toLowerCase());

  if (!album) {
    album = {
      name: albumName,
      cover: "",
      songs: []
    };
    artist.albums.push(album);
  }

  return album;
}

function normalizeLibrary(library) {
  const artists = Array.isArray(library?.artists) ? library.artists : [];

  return sortLibrary({
    artists: artists.map(normalizeArtist).filter(Boolean)
  });
}

function normalizeArtist(artist) {
  const name = cleanText(artist?.name);

  if (!name) {
    return null;
  }

  return {
    name,
    albums: (Array.isArray(artist.albums) ? artist.albums : [])
      .map(normalizeAlbum)
      .filter(Boolean)
  };
}

function normalizeAlbum(album) {
  const name = cleanText(album?.name) || "Unknown Album";

  return {
    name,
    cover: cleanText(album?.cover),
    songs: (Array.isArray(album?.songs) ? album.songs : [])
      .map(normalizeSong)
      .filter(Boolean)
  };
}

function normalizeSong(song) {
  const title = cleanText(song?.title);

  if (!title) {
    return null;
  }

  return {
    title,
    summary: cleanText(song?.summary),
    context: cleanText(song?.context),
    interpretation: cleanText(song?.interpretation),
    feeling: cleanText(song?.feeling),
    tags: Array.isArray(song?.tags) ? song.tags.map(cleanText).filter(Boolean) : [],
    interpretationDepth: normalizeDepth(song?.interpretationDepth),
    interpretationStatus: normalizeInterpretationStatus(song?.interpretationStatus, song),
    generatedBy: cleanText(song?.generatedBy),
    generatedAt: cleanText(song?.generatedAt)
  };
}

function normalizeImportedSong(song) {
  const artist = cleanText(song.artist) || "Unknown Artist";
  const album = cleanText(song.album) || "Unknown Album";
  const title = cleanText(song.title);

  if (!title) {
    return null;
  }

  return { artist, album, title };
}

function createSong(title) {
  return {
    title,
    summary: "",
    context: "",
    interpretation: "",
    feeling: "",
    tags: [],
    interpretationDepth: 0,
    interpretationStatus: "not-generated",
    generatedBy: "",
    generatedAt: ""
  };
}

function createEmptyLibrary() {
  return {
    artists: []
  };
}

function sortLibrary(library) {
  const sorted = normalizeLibraryWithoutSorting(library);

  sorted.artists.sort((a, b) => a.name.localeCompare(b.name));
  sorted.artists.forEach((artist) => {
    artist.albums.sort((a, b) => a.name.localeCompare(b.name));
    artist.albums.forEach((album) => {
      album.songs.sort((a, b) => a.title.localeCompare(b.title));
    });
  });

  return sorted;
}

function normalizeLibraryWithoutSorting(library) {
  return {
    artists: (Array.isArray(library?.artists) ? library.artists : []).map((artist) => ({
      name: cleanText(artist.name),
      albums: (Array.isArray(artist.albums) ? artist.albums : []).map((album) => ({
        name: cleanText(album.name) || "Unknown Album",
        cover: cleanText(album.cover),
        songs: (Array.isArray(album.songs) ? album.songs : []).map((song) => ({
          title: cleanText(song.title),
          summary: cleanText(song.summary),
          context: cleanText(song.context),
          interpretation: cleanText(song.interpretation),
          feeling: cleanText(song.feeling),
          tags: Array.isArray(song.tags) ? song.tags.map(cleanText).filter(Boolean) : [],
          interpretationDepth: normalizeDepth(song.interpretationDepth),
          interpretationStatus: normalizeInterpretationStatus(song.interpretationStatus, song),
          generatedBy: cleanText(song.generatedBy),
          generatedAt: cleanText(song.generatedAt)
        })).filter((song) => song.title)
      }))
    })).filter((artist) => artist.name)
  };
}

function normalizeDepth(value) {
  const depth = Number(value);

  if (!Number.isFinite(depth)) {
    return 0;
  }

  return Math.min(5, Math.max(0, Math.round(depth)));
}

function normalizeInterpretationStatus(status, song) {
  const cleanedStatus = cleanText(status);

  if (["generated", "edited-manually", "not-generated"].includes(cleanedStatus)) {
    return cleanedStatus;
  }

  return hasInterpretationData(song) ? "generated" : "not-generated";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getFilteredLibrary() {
  if (!state.search) {
    return state.library;
  }

  const artists = state.library.artists
    .map((artist) => {
      const albums = artist.albums
        .map((album) => {
          const songs = album.songs.filter((song) => {
            const haystack = `${artist.name} ${album.name} ${song.title}`.toLowerCase();
            return haystack.includes(state.search);
          });

          if (songs.length || `${artist.name} ${album.name}`.toLowerCase().includes(state.search)) {
            return {
              ...album,
              songs: songs.length ? songs : album.songs
            };
          }

          return null;
        })
        .filter(Boolean);

      if (albums.length || artist.name.toLowerCase().includes(state.search)) {
        return {
          ...artist,
          albums: albums.length ? albums : artist.albums
        };
      }

      return null;
    })
    .filter(Boolean);

  return { artists };
}

function render() {
  const filteredLibrary = getFilteredLibrary();
  const totalSongs = getSongCount(state.library);
  const visibleSongs = getSongCount(filteredLibrary);

  libraryElement.innerHTML = "";

  if (!totalSongs) {
    libraryElement.append(createEmptyState("No music library loaded yet."));
    return;
  }

  if (!visibleSongs) {
    libraryElement.append(createEmptyState("No matches for this search."));
    setStatus(state.operationStatus || `Showing 0 of ${totalSongs} songs.`);
    return;
  }

  filteredLibrary.artists.forEach((artist) => {
    libraryElement.append(createArtistCard(artist));
  });

  setStatus(state.operationStatus || `Showing ${visibleSongs} of ${totalSongs} songs. Source: ${state.loadedFrom}.${state.hasUnsavedChanges ? " Unsaved changes." : ""}`);
}

function createArtistCard(artist) {
  const artistCard = document.createElement("article");
  artistCard.className = "artist-card";
  artistCard.classList.toggle("is-open", state.openArtists.has(artist.name) || Boolean(state.search));

  const songCount = artist.albums.reduce((total, album) => total + album.songs.length, 0);
  const header = document.createElement("button");
  header.className = "artist-header";
  header.type = "button";
  header.innerHTML = `
    <span class="artist-title">
      <strong>${escapeHtml(artist.name)}</strong>
      <span class="count">${artist.albums.length} albums / ${songCount} songs</span>
    </span>
    <span class="chevron">${artistCard.classList.contains("is-open") ? "v" : ">"}</span>
  `;
  header.addEventListener("click", () => {
    toggleSetValue(state.openArtists, artist.name);
    render();
  });

  const body = document.createElement("div");
  body.className = "artist-body";
  artist.albums.forEach((album) => {
    body.append(createAlbumCard(artist.name, album));
  });

  artistCard.append(header, body);
  return artistCard;
}

function createAlbumCard(artistName, album) {
  const albumKey = getAlbumKey(artistName, album.name);
  const albumCard = document.createElement("article");
  albumCard.className = "album-card";
  albumCard.classList.toggle("is-open", state.openAlbums.has(albumKey) || Boolean(state.search));

  const header = document.createElement("button");
  header.className = "album-header";
  header.type = "button";
  header.innerHTML = `
    <span class="album-title">
      <strong>${escapeHtml(album.name)}</strong>
      <span class="count">${album.songs.length} songs</span>
    </span>
    <span class="chevron">${albumCard.classList.contains("is-open") ? "v" : ">"}</span>
  `;
  header.addEventListener("click", () => {
    toggleSetValue(state.openAlbums, albumKey);
    render();
  });

  const body = document.createElement("div");
  body.className = "album-body";
  album.songs.forEach((song) => {
    body.append(createSongRow(artistName, album.name, song));
  });

  albumCard.append(header, body);
  return albumCard;
}

function createSongRow(artistName, albumName, song) {
  const songKey = getSongKey(artistName, albumName, song.title);
  const isVisible = state.visibleInterpretations.has(songKey);
  const isEditing = state.editingInterpretations.has(songKey);
  const isGenerating = state.generatingInterpretations.has(songKey);
  const interpretationStatus = getInterpretationStatus(song);
  const songRow = document.createElement("article");
  songRow.className = "song-row";

  const songMain = document.createElement("div");
  songMain.className = "song-main";
  songMain.innerHTML = `
    <span class="song-title-line">
      <strong>${escapeHtml(song.title)}</strong>
      ${renderStatusBadge(interpretationStatus)}
    </span>
    <span class="song-meta">${escapeHtml(artistName)} / ${escapeHtml(albumName)}</span>
  `;

  const actions = document.createElement("div");
  actions.className = "song-actions";

  if (hasInterpretation(song)) {
    const toggleButton = createActionButton(isVisible ? "Hide interpretation" : "Show interpretation");
    toggleButton.addEventListener("click", () => {
      toggleSetValue(state.visibleInterpretations, songKey);
      if (!state.visibleInterpretations.has(songKey)) {
        state.editingInterpretations.delete(songKey);
      }
      render();
    });
    actions.append(toggleButton);

    const regenerateButton = createActionButton(isGenerating ? "Generating..." : "Generate Real Interpretation");
    setGenerateButtonData(regenerateButton, artistName, albumName, song.title);
    regenerateButton.disabled = isGenerating;
    actions.append(regenerateButton);

    const editButton = createActionButton(isEditing ? "Cancel edit" : "Edit");
    editButton.addEventListener("click", () => {
      state.visibleInterpretations.add(songKey);
      toggleSetValue(state.editingInterpretations, songKey);
      render();
    });
    actions.append(editButton);
  } else {
    const generateButton = createActionButton(isGenerating ? "Generating..." : "Generate Real Interpretation");
    setGenerateButtonData(generateButton, artistName, albumName, song.title);
    generateButton.disabled = isGenerating;
    actions.append(generateButton);
  }

  const interpretation = document.createElement("section");
  interpretation.className = "interpretation";
  interpretation.classList.toggle("is-visible", isVisible);

  if (isEditing) {
    interpretation.append(createInterpretationEditor(artistName, albumName, song));
  } else {
    interpretation.innerHTML = renderInterpretation(song);
  }

  songRow.append(songMain, actions, interpretation);
  return songRow;
}

function createActionButton(label) {
  const button = document.createElement("button");
  button.className = "generate-button";
  button.type = "button";
  button.textContent = label;
  return button;
}

function setGenerateButtonData(button, artistName, albumName, songTitle) {
  button.dataset.generateReal = "true";
  button.dataset.artistName = artistName;
  button.dataset.albumName = albumName;
  button.dataset.songTitle = songTitle;
}

async function handleGenerateInterpretation(artistName, albumName, songTitle, clickedSong) {
  const songKey = getSongKey(artistName, albumName, songTitle);
  const song = findSong(state.library, artistName, albumName, songTitle);

  console.log("Generate Real Interpretation clicked", song || clickedSong);
  setOperationStatus("Starting real interpretation generation...");

  if (typeof generateRealInterpretation !== "function") {
    const message = "generateRealInterpretation is not defined. Real interpretation was not generated.";
    console.error(message);
    setOperationStatus(message);
    return;
  }

  if (!song) {
    const message = "Song could not be found. Real interpretation was not generated.";
    console.error(message);
    setOperationStatus(message);
    return;
  }

  state.generatingInterpretations.add(songKey);
  render();

  try {
    await writeGeneratedInterpretation(artistName, albumName, songTitle);
    state.visibleInterpretations.add(songKey);
    state.editingInterpretations.delete(songKey);
    setOperationStatus("Interpretation generated. Remember to Save songs.json.");
  } catch (error) {
    console.error(`OpenAI API error: ${error.message || error}`);
    setOperationStatus(error.message || "Could not generate interpretation.");
  } finally {
    state.generatingInterpretations.delete(songKey);
    render();
  }
}

async function writeGeneratedInterpretation(artistName, albumName, songTitle) {
  const song = findSong(state.library, artistName, albumName, songTitle);

  if (!song) {
    return false;
  }

  console.log(`Generating REAL interpretation for: ${artistName} / ${albumName} / ${songTitle}`);
  const generated = await generateRealInterpretation({
    artist: artistName,
    album: albumName,
    title: songTitle
  });

  song.summary = generated.summary;
  song.context = generated.context;
  song.interpretation = generated.interpretation;
  song.feeling = generated.feeling;
  song.tags = generated.tags;
  song.interpretationDepth = generated.interpretationDepth;
  song.interpretationStatus = "generated";
  song.generatedBy = "openai";
  song.generatedAt = new Date().toISOString();

  await persistLibraryChange();
  return true;
}

async function generateRealInterpretation(song) {
  const apiKey = getOpenAiApiKey();

  if (!apiKey) {
    const message = "OpenAI API key is missing. Real interpretation was not generated.";
    console.error(`OpenAI API error: ${message}`);
    throw new Error(message);
  }

  setOperationStatus("Calling OpenAI API...");
  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a music analyst and cultural commentator. Return only valid JSON and never quote song lyrics."
        },
        {
          role: "user",
          content: createInterpretationPrompt(song)
        }
      ]
    })
  });

  if (!response.ok) {
    let details = "";

    try {
      const errorBody = await response.json();
      details = errorBody?.error?.message ? ` ${errorBody.error.message}` : "";
    } catch (error) {
      details = "";
    }

    const message = `OpenAI API request failed (${response.status}).${details}`;
    console.error(`OpenAI API error: ${message}`);
    throw new Error(message);
  }

  const data = await response.json();
  console.log("OpenAI API response received");
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    const message = "OpenAI API returned an empty response.";
    console.error(`OpenAI API error: ${message}`);
    throw new Error(message);
  }

  try {
    return normalizeGeneratedInterpretation(parseInterpretationJson(content));
  } catch (error) {
    console.error(`OpenAI API error: ${error.message}`);
    throw error;
  }
}

function getOpenAiApiKey() {
  return String(window.BTL_CONFIG?.OPENAI_API_KEY || "").trim();
}

function createInterpretationPrompt(song) {
  const artist = song.artist || "Unknown Artist";
  const album = song.album || "Unknown Album";
  const title = song.title || "Untitled";

  return `You are a music analyst and cultural commentator.

Your task is to create a high-quality song interpretation for a public website called "Behind The Lyrics".

The goal is NOT to invent meanings.

The goal is to provide a thoughtful and plausible interpretation based on:

* the artist
* the album
* the song title
* known themes in the artist's work
* historical and cultural context
* commonly discussed interpretations

IMPORTANT RULES:

* Never quote song lyrics.
* Never invent facts.
* If information is uncertain, say "may", "can be interpreted as", or "is often understood as".
* Avoid generic AI phrases.
* Avoid filler language.
* Avoid repeating the song title.
* Write as a knowledgeable music journalist.
* Make each interpretation clearly distinct from other songs.
* Prioritize insight over length.

INPUT

Artist: ${artist}
Album: ${album}
Song: ${title}

OUTPUT FORMAT

Return ONLY valid JSON.

{
"summary": "",
"context": "",
"interpretation": "",
"feeling": "",
"tags": [],
"interpretationDepth": 1
}

FIELD REQUIREMENTS

summary:
One sentence (max 25 words).
Capture the central idea of the song.

context:
2-4 sentences.
Describe where the song fits within the artist's career, album or historical period.

interpretation:
4-8 sentences.
Explain the most plausible meaning and themes.
Discuss symbolism or recurring ideas when relevant.

feeling:
One short paragraph.
Describe the emotional atmosphere.

tags:
3-8 tags.
Examples:
["nostalgia","identity","working class","love","alienation","faith","politics"]

interpretationDepth:
Integer from 1 to 5.

1 = straightforward song
3 = multiple possible readings
5 = rich symbolism and extensive interpretation potential

QUALITY TEST

Before returning the result, verify:

* Would this interpretation still make sense if the song title were replaced with another title?

If YES, rewrite it.

* Does the interpretation contain specific observations about this artist, album or song?

If NO, rewrite it.

Return only the JSON object.`;
}

function parseInterpretationJson(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error("OpenAI API response was not valid JSON.");
    }

    try {
      return JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    } catch (parseError) {
      throw new Error("OpenAI API response was not valid JSON.");
    }
  }
}

function normalizeGeneratedInterpretation(result) {
  return {
    summary: cleanText(result?.summary),
    context: cleanText(result?.context),
    interpretation: cleanText(result?.interpretation),
    feeling: cleanText(result?.feeling),
    tags: Array.isArray(result?.tags) ? result.tags.map(cleanText).filter(Boolean).slice(0, 8) : [],
    interpretationDepth: Math.max(1, normalizeDepth(result?.interpretationDepth) || 1)
  };
}

function generateMockInterpretation(song) {
  const profile = getInterpretationProfile(song);
  const artist = song.artist || "Unknown Artist";
  const album = song.album || "Unknown Album";
  const title = song.title || "Untitled";

  return {
    summary: profile.summary,
    context: `${artist}'s "${title}" sits within the world of "${album}", so this reading treats the song as part of that album's broader mood rather than as a line-by-line lyric analysis.`,
    interpretation: `A mock-only draft for "${title}" would frame the song around ${profile.theme}. In the context of ${artist}'s catalog, it should be treated as placeholder text until real OpenAI generation is configured.`,
    feeling: profile.feeling,
    tags: profile.tags,
    interpretationDepth: profile.depth
  };
}

function getInterpretationProfile(song) {
  const text = `${song.artist} ${song.album} ${song.title}`.toLowerCase();

  if (/(river|road|highway|train|border|journey|street|avenue)/.test(text)) {
    return {
      summary: "Movement, longing, and the cost of change.",
      theme: "transition, escape, and the uneasy promise of a different life",
      feeling: "Restless, reflective, and quietly hopeful.",
      tags: ["Journey", "Longing", "Change"],
      depth: 5
    };
  }

  if (/(love|heart|kiss|want|baby|girl|lady|sweet|tonight)/.test(text)) {
    return {
      summary: "Desire seen through memory and uncertainty.",
      theme: "romance as both an invitation and a source of confusion",
      feeling: "Tender, searching, and bittersweet.",
      tags: ["Love", "Memory", "Vulnerability"],
      depth: 4
    };
  }

  if (/(war|heaven|death|grave|murder|blood|storm|desolation|dark)/.test(text)) {
    return {
      summary: "A meditation on danger, loss, and moral weather.",
      theme: "mortality, fear, and the search for meaning when certainty falls away",
      feeling: "Haunted, solemn, and intense.",
      tags: ["Mortality", "Conflict", "Reflection"],
      depth: 5
    };
  }

  if (/(rock|roll|star|band|song|music|guitar|blues)/.test(text)) {
    return {
      summary: "A self-aware glance at performance and identity.",
      theme: "the tension between artistic freedom, public image, and the machinery around music",
      feeling: "Wry, energetic, and observant.",
      tags: ["Music", "Identity", "Performance"],
      depth: 4
    };
  }

  return {
    summary: "A compact portrait of inner conflict and perspective.",
    theme: "identity, memory, and the private meanings people attach to experience",
    feeling: "Reflective, intimate, and open-ended.",
    tags: ["Reflection", "Identity", "Inner life"],
    depth: 3
  };
}

function renderInterpretation(song) {
  const interpretation = hasInterpretation(song)
    ? song
    : {
      summary: "No interpretation generated yet.",
      context: "",
      interpretation: "",
      feeling: "",
      tags: [],
      interpretationDepth: 0
    };

  return `
    <div class="interpretation-block">
      <h4>Summary</h4>
      <p>${escapeHtml(interpretation.summary)}</p>
    </div>
    <div class="interpretation-block">
      <h4>Context</h4>
      <p>${escapeHtml(interpretation.context || "Pending generation.")}</p>
    </div>
    <div class="interpretation-block">
      <h4>Possible interpretation</h4>
      <p>${escapeHtml(interpretation.interpretation || "Pending generation.")}</p>
    </div>
    <div class="interpretation-block">
      <h4>Feeling</h4>
      <p>${escapeHtml(interpretation.feeling || "Pending generation.")}</p>
    </div>
    <div class="interpretation-block">
      <h4>Depth</h4>
      <p>${escapeHtml(renderDepth(interpretation.interpretationDepth))}</p>
    </div>
    <div class="tags">
      ${(interpretation.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
    </div>
  `;
}

function hasInterpretation(song) {
  return hasInterpretationData(song);
}

function hasInterpretationData(song) {
  return Boolean(song?.summary || song?.context || song?.interpretation || song?.feeling || song?.tags?.length || song?.interpretationDepth);
}

function getInterpretationStatus(song) {
  if (song.interpretationStatus === "edited-manually") {
    return "edited-manually";
  }

  if (hasInterpretation(song)) {
    return "generated";
  }

  return "not-generated";
}

function renderStatusBadge(status) {
  const labels = {
    "not-generated": "Not generated",
    generated: "Generated",
    "edited-manually": "Edited manually"
  };

  return `<span class="status-badge status-badge--${status}">${labels[status]}</span>`;
}

function renderDepth(depth) {
  const normalizedDepth = normalizeDepth(depth);
  return normalizedDepth ? `${normalizedDepth}/5` : "Pending generation.";
}

function createInterpretationEditor(artistName, albumName, song) {
  const songKey = getSongKey(artistName, albumName, song.title);
  const form = document.createElement("form");
  form.className = "interpretation-editor";
  form.innerHTML = `
    <label>
      <span>Summary</span>
      <input name="summary" value="${escapeAttribute(song.summary)}">
    </label>
    <label>
      <span>Context</span>
      <textarea name="context" rows="3">${escapeHtml(song.context)}</textarea>
    </label>
    <label>
      <span>Possible interpretation</span>
      <textarea name="interpretation" rows="4">${escapeHtml(song.interpretation)}</textarea>
    </label>
    <label>
      <span>Feeling</span>
      <input name="feeling" value="${escapeAttribute(song.feeling)}">
    </label>
    <label>
      <span>Tags</span>
      <input name="tags" value="${escapeAttribute((song.tags || []).join(", "))}">
    </label>
    <label>
      <span>Depth 1-5</span>
      <input name="interpretationDepth" type="number" min="1" max="5" value="${escapeAttribute(song.interpretationDepth || 3)}">
    </label>
    <div class="editor-actions">
      <button class="secondary-button" type="submit">Save edits</button>
      <button class="generate-button" type="button" data-cancel-edit>Cancel</button>
    </div>
  `;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const editableSong = findSong(state.library, artistName, albumName, song.title);

    if (!editableSong) {
      return;
    }

    editableSong.summary = cleanText(formData.get("summary"));
    editableSong.context = cleanText(formData.get("context"));
    editableSong.interpretation = cleanText(formData.get("interpretation"));
    editableSong.feeling = cleanText(formData.get("feeling"));
    editableSong.tags = parseTags(formData.get("tags"));
    editableSong.interpretationDepth = Math.max(1, normalizeDepth(formData.get("interpretationDepth")) || 1);
    editableSong.interpretationStatus = "edited-manually";

    state.editingInterpretations.delete(songKey);
    state.visibleInterpretations.add(songKey);
    await persistLibraryChange();
    render();
    setStatus(`Saved manual edits for "${song.title}". ${getPersistenceHint()}`);
  });

  form.querySelector("[data-cancel-edit]").addEventListener("click", () => {
    state.editingInterpretations.delete(songKey);
    render();
  });

  return form;
}

function parseTags(value) {
  return String(value || "")
    .split(",")
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 8);
}

function findSong(library, artistName, albumName, songTitle) {
  const artist = library.artists.find((item) => item.name === artistName);
  const album = artist?.albums.find((item) => item.name === albumName);
  return album?.songs.find((item) => item.title === songTitle);
}

function createEmptyState(message) {
  const emptyState = document.createElement("div");
  emptyState.className = "empty-state";
  emptyState.textContent = message;
  return emptyState;
}

function toggleSetValue(set, value) {
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
}

function getSongKey(artist, album, title) {
  return `${artist}::${album}::${title}`.toLowerCase();
}

function getAlbumKey(artist, album) {
  return `${artist}::${album}`.toLowerCase();
}

function getSongCount(library) {
  return library.artists.reduce((artistTotal, artist) => {
    return artistTotal + artist.albums.reduce((albumTotal, album) => albumTotal + album.songs.length, 0);
  }, 0);
}

function cacheLibrary() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(sortLibrary(state.library)));
}

function loadCachedLibrary() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return cached ? normalizeLibrary(cached) : null;
  } catch (error) {
    console.warn(error);
    return null;
  }
}

function getPersistenceHint() {
  if (state.fileHandle && !state.hasUnsavedChanges) {
    return "songs.json was updated directly. Remaining manual step: commit and push to GitHub.";
  }

  if (state.fileHandle) {
    return "Use Save songs.json, then commit and push to GitHub.";
  }

  return "Open songs.json for direct admin saving, or use Download copy as fallback.";
}

function setStatus(message) {
  statusText.textContent = message;
}

function setOperationStatus(message) {
  state.operationStatus = message;
  setStatus(message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
