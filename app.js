const DATA_URL = "songs.json";
const CACHE_KEY = "behindTheLyrics.libraryCache.v2";

const state = {
  library: createEmptyLibrary(),
  search: "",
  openArtists: new Set(),
  openAlbums: new Set(),
  visibleInterpretations: new Set(),
  loadedFrom: "memory"
};

const fileInput = document.querySelector("#fileInput");
const searchInput = document.querySelector("#searchInput");
const exportButton = document.querySelector("#exportButton");
const clearButton = document.querySelector("#clearButton");
const libraryElement = document.querySelector("#library");
const statusText = document.querySelector("#statusText");

init();

async function init() {
  fileInput.addEventListener("change", handleFileImport);
  searchInput.addEventListener("input", handleSearch);
  exportButton.addEventListener("click", exportLibrary);
  clearButton.addEventListener("click", clearLibrary);

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
    cacheLibrary();
    setStatus(`Loaded ${getSongCount(state.library)} songs from songs.json.`);
  } catch (error) {
    console.warn(error);
    const cachedLibrary = loadCachedLibrary();

    if (cachedLibrary) {
      state.library = cachedLibrary;
      state.loadedFrom = "temporary cache";
      setStatus("songs.json could not be loaded locally. Showing temporary cached data.");
      return;
    }

    state.library = createEmptyLibrary();
    state.loadedFrom = "empty";
    setStatus("songs.json could not be loaded. Import a CSV/M3U file, then export songs.json.");
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
    render();
    setStatus(`Imported ${importedSongs.length} songs. Export Library to create an updated songs.json.`);
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

function clearLibrary() {
  state.library = createEmptyLibrary();
  state.openArtists.clear();
  state.openAlbums.clear();
  state.visibleInterpretations.clear();
  localStorage.removeItem(CACHE_KEY);
  render();
  setStatus("Local working library cleared. Export if you want to replace songs.json with an empty library.");
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
    tags: Array.isArray(song?.tags) ? song.tags.map(cleanText).filter(Boolean) : []
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
    tags: []
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
          tags: Array.isArray(song.tags) ? song.tags.map(cleanText).filter(Boolean) : []
        })).filter((song) => song.title)
      }))
    })).filter((artist) => artist.name)
  };
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
    setStatus(`Showing 0 of ${totalSongs} songs.`);
    return;
  }

  filteredLibrary.artists.forEach((artist) => {
    libraryElement.append(createArtistCard(artist));
  });

  setStatus(`Showing ${visibleSongs} of ${totalSongs} songs. Source: ${state.loadedFrom}.`);
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
  const songRow = document.createElement("article");
  songRow.className = "song-row";

  const songMain = document.createElement("div");
  songMain.className = "song-main";
  songMain.innerHTML = `
    <strong>${escapeHtml(song.title)}</strong>
    <span>${escapeHtml(artistName)} / ${escapeHtml(albumName)}</span>
  `;

  const button = document.createElement("button");
  button.className = "generate-button";
  button.type = "button";
  button.textContent = hasInterpretation(song)
    ? "Show interpretation"
    : "Generate interpretation";

  if (state.visibleInterpretations.has(songKey)) {
    button.textContent = "Hide interpretation";
  }

  const interpretation = document.createElement("section");
  interpretation.className = "interpretation";
  interpretation.classList.toggle("is-visible", state.visibleInterpretations.has(songKey));
  interpretation.innerHTML = renderInterpretation(song);

  button.addEventListener("click", () => {
    let generatedNewInterpretation = false;

    if (!hasInterpretation(song)) {
      writeGeneratedInterpretation(artistName, albumName, song.title);
      state.visibleInterpretations.add(songKey);
      cacheLibrary();
      generatedNewInterpretation = true;
    } else {
      toggleSetValue(state.visibleInterpretations, songKey);
    }

    render();

    if (generatedNewInterpretation) {
      setStatus("Generated a placeholder interpretation in the JSON data structure. Export Library to save songs.json.");
    }
  });

  songRow.append(songMain, button, interpretation);
  return songRow;
}

function writeGeneratedInterpretation(artistName, albumName, songTitle) {
  const song = findSong(state.library, artistName, albumName, songTitle);

  if (!song) {
    return;
  }

  const generated = generateInterpretation({
    artist: artistName,
    album: albumName,
    title: songTitle
  });

  song.summary = generated.summary;
  song.context = generated.context;
  song.interpretation = generated.interpretation;
  song.feeling = generated.feeling;
  song.tags = generated.tags;
}

function generateInterpretation(song) {
  return {
    summary: `A possible reading of the themes and context around "${song.title}" by ${song.artist}.`,
    context: `This section will later contain background and context for the song from the album "${song.album}".`,
    interpretation: "A short AI-generated interpretation will appear here without showing the lyrics.",
    feeling: "Melancholic, reflective or energetic depending on the song.",
    tags: ["Theme", "Mood", "Story"]
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
      tags: []
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
    <div class="tags">
      ${(interpretation.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
    </div>
  `;
}

function hasInterpretation(song) {
  return Boolean(song.summary || song.context || song.interpretation || song.feeling || song.tags.length);
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
