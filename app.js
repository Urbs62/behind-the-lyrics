const STORAGE_KEY = "behindTheLyrics.library.v1";

const state = {
  songs: [],
  search: "",
  openArtists: new Set(),
  openAlbums: new Set(),
  visibleInterpretations: new Set()
};

const fileInput = document.querySelector("#fileInput");
const searchInput = document.querySelector("#searchInput");
const clearButton = document.querySelector("#clearButton");
const library = document.querySelector("#library");
const statusText = document.querySelector("#statusText");

init();

function init() {
  state.songs = loadSongs();
  fileInput.addEventListener("change", handleFileImport);
  searchInput.addEventListener("input", handleSearch);
  clearButton.addEventListener("click", clearLibrary);
  render();
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
      setStatus("Filen kunde läsas, men inga låtar hittades.");
      return;
    }

    state.songs = mergeSongs(state.songs, importedSongs);
    state.openArtists = new Set(importedSongs.map((song) => song.artist));
    state.openAlbums = new Set(importedSongs.map((song) => getAlbumKey(song.artist, song.album)));
    saveSongs(state.songs);
    render();
    setStatus(`Importerade ${importedSongs.length} låtar. Biblioteket innehåller nu ${state.songs.length} låtar.`);
  } catch (error) {
    console.error(error);
    setStatus("Något gick fel vid importen. Kontrollera filformatet och försök igen.");
  } finally {
    fileInput.value = "";
  }
}

function handleSearch(event) {
  state.search = event.target.value.trim().toLowerCase();
  render();
}

function clearLibrary() {
  state.songs = [];
  state.openArtists.clear();
  state.openAlbums.clear();
  state.visibleInterpretations.clear();
  localStorage.removeItem(STORAGE_KEY);
  render();
  setStatus("All importerad data är rensad.");
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
    .map((row) => normalizeSong({
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
    songs.push(normalizeSong({
      artist: pendingExtinf?.artist || pathInfo.artist,
      album: pathInfo.album || "Unknown Album",
      title: pendingExtinf?.title || pathInfo.title
    }));
    pendingExtinf = null;
  });

  return songs.filter(Boolean);
}

function parseExtinf(line) {
  const metadata = line.slice(line.indexOf(",") + 1).trim();
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

function normalizeSong(song) {
  const artist = cleanText(song.artist) || "Unknown Artist";
  const album = cleanText(song.album) || "Unknown Album";
  const title = cleanText(song.title);

  if (!title) {
    return null;
  }

  return { artist, album, title };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mergeSongs(existingSongs, incomingSongs) {
  const byKey = new Map();

  [...existingSongs, ...incomingSongs].forEach((song) => {
    byKey.set(getSongKey(song), song);
  });

  return sortSongs([...byKey.values()]);
}

function sortSongs(songs) {
  return [...songs].sort((a, b) => {
    return a.artist.localeCompare(b.artist)
      || a.album.localeCompare(b.album)
      || a.title.localeCompare(b.title);
  });
}

function buildArtists(songs) {
  const artistMap = new Map();

  sortSongs(songs).forEach((song) => {
    if (!artistMap.has(song.artist)) {
      artistMap.set(song.artist, {
        name: song.artist,
        albums: new Map()
      });
    }

    const artist = artistMap.get(song.artist);
    if (!artist.albums.has(song.album)) {
      artist.albums.set(song.album, {
        name: song.album,
        songs: []
      });
    }

    artist.albums.get(song.album).songs.push(song);
  });

  return [...artistMap.values()].map((artist) => ({
    name: artist.name,
    albums: [...artist.albums.values()]
  }));
}

function getFilteredSongs() {
  if (!state.search) {
    return state.songs;
  }

  return state.songs.filter((song) => {
    const haystack = `${song.artist} ${song.album} ${song.title}`.toLowerCase();
    return haystack.includes(state.search);
  });
}

function render() {
  const filteredSongs = getFilteredSongs();
  const artists = buildArtists(filteredSongs);

  library.innerHTML = "";

  if (!state.songs.length) {
    library.append(createEmptyState("Ingen musik importerad an."));
    setStatus("Importera en CSV-, M3U- eller M3U8-fil för att komma igång.");
    return;
  }

  if (!filteredSongs.length) {
    library.append(createEmptyState("Inga traffar for sokningen."));
    setStatus(`Visar 0 av ${state.songs.length} låtar.`);
    return;
  }

  artists.forEach((artist) => {
    library.append(createArtistCard(artist));
  });

  setStatus(`Visar ${filteredSongs.length} av ${state.songs.length} låtar.`);
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
      <span class="count">${artist.albums.length} album / ${songCount} låtar</span>
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
      <span class="count">${album.songs.length} låtar</span>
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
    body.append(createSongRow(song));
  });

  albumCard.append(header, body);
  return albumCard;
}

function createSongRow(song) {
  const songKey = getSongKey(song);
  const songRow = document.createElement("article");
  songRow.className = "song-row";

  const songMain = document.createElement("div");
  songMain.className = "song-main";
  songMain.innerHTML = `
    <strong>${escapeHtml(song.title)}</strong>
    <span>${escapeHtml(song.artist)} / ${escapeHtml(song.album)}</span>
  `;

  const button = document.createElement("button");
  button.className = "generate-button";
  button.type = "button";
  button.textContent = state.visibleInterpretations.has(songKey)
    ? "Hide interpretation"
    : "Generate interpretation";

  const interpretation = document.createElement("section");
  interpretation.className = "interpretation";
  interpretation.classList.toggle("is-visible", state.visibleInterpretations.has(songKey));
  interpretation.innerHTML = renderInterpretation(generateInterpretation(song));

  button.addEventListener("click", () => {
    toggleSetValue(state.visibleInterpretations, songKey);
    render();
  });

  songRow.append(songMain, button, interpretation);
  return songRow;
}

function generateInterpretation(song) {
  return {
    oneLiner: `En möjlig tolkning av teman och sammanhang i "${song.title}" av ${song.artist}.`,
    context: `Den här sektionen kommer senare att innehålla bakgrund och sammanhang för låten från albumet "${song.album}".`,
    possibleInterpretation: "Här kommer en kort AI-genererad tolkning utan att visa själva låttexten.",
    feeling: "Melankolisk, reflekterande eller energisk beroende på låt.",
    tags: ["Theme", "Mood", "Story"]
  };
}

function renderInterpretation(interpretation) {
  return `
    <div class="interpretation-block">
      <h4>One-liner</h4>
      <p>${escapeHtml(interpretation.oneLiner)}</p>
    </div>
    <div class="interpretation-block">
      <h4>Context</h4>
      <p>${escapeHtml(interpretation.context)}</p>
    </div>
    <div class="interpretation-block">
      <h4>Possible interpretation</h4>
      <p>${escapeHtml(interpretation.possibleInterpretation)}</p>
    </div>
    <div class="interpretation-block">
      <h4>Feeling</h4>
      <p>${escapeHtml(interpretation.feeling)}</p>
    </div>
    <div class="tags">
      ${interpretation.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
    </div>
  `;
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

function getSongKey(song) {
  return `${song.artist}::${song.album}::${song.title}`.toLowerCase();
}

function getAlbumKey(artist, album) {
  return `${artist}::${album}`.toLowerCase();
}

function saveSongs(songs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sortSongs(songs)));
}

function loadSongs() {
  try {
    const storedSongs = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(storedSongs)
      ? sortSongs(storedSongs.map(normalizeSong).filter(Boolean))
      : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

function setStatus(message) {
  statusText.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
