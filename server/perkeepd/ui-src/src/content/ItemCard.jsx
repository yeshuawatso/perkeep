import { useRef, useState } from "react";
import Form from "react-bootstrap/Form";

import { addAttribute, bucketHeight, downloadUrl, thumbnailUrl } from "../api/client.js";
import { classify, INTERNAL_DRAG_MIME, isSet, titleOf } from "./classify.js";

// Builds a small offscreen "stack of cards" clone used as the drag image
// when dragging a multi-selection, so dropping clearly reads as "moving
// several items" rather than looking like a single-item drag. Removed again
// on dragend. 1-2 items just keep the browser's own default drag image.
function buildStackDragImage(count) {
  const n = Math.min(count, 4);
  const wrap = document.createElement("div");
  wrap.style.position = "fixed";
  wrap.style.top = "-1000px";
  wrap.style.left = "-1000px";
  wrap.style.width = "90px";
  wrap.style.height = "90px";
  for (let i = n - 1; i >= 0; i--) {
    const card = document.createElement("div");
    card.style.position = "absolute";
    card.style.top = `${i * 6}px`;
    card.style.left = `${i * 6}px`;
    card.style.width = "70px";
    card.style.height = "70px";
    card.style.borderRadius = "6px";
    card.style.border = "1px solid rgba(0,0,0,.25)";
    card.style.background = "#fff";
    card.style.boxShadow = "0 1px 4px rgba(0,0,0,.35)";
    wrap.appendChild(card);
  }
  document.body.appendChild(wrap);
  return wrap;
}

// One grid cell. Dispatches on classify()'s result the same way the old
// index.js's BLOB_ITEM_HANDLERS_ chain did -- every content type below is a
// 1:1 port of a blob_item_*_content.js file (see perkeep-ui-spec.md §5).
// Note: prop is "blobRef", not "ref" -- React intercepts a literal `ref`
// prop on any component for its own ref-forwarding mechanism, so a plain
// function component never actually receives it as a normal prop.
export default function ItemCard({
  disco,
  meta,
  blobRef,
  selected,
  selectable,
  onToggleSelect,
  onOpen,
  selectedRefs,
  onDroppedMembers,
}) {
  const item = classify(meta, blobRef);
  const attrs = meta[blobRef]?.permanode?.attr;
  const isDropTarget = isSet(attrs);
  const showSetBadge = isDropTarget && !!item.file;
  const [dragOver, setDragOver] = useState(false);

  function onDragStart(e) {
    const refs = selected && selectedRefs?.length > 1 ? selectedRefs : [blobRef];
    e.dataTransfer.setData(INTERNAL_DRAG_MIME, JSON.stringify(refs));
    e.dataTransfer.effectAllowed = "copy";
    if (refs.length > 1) {
      const img = buildStackDragImage(refs.length);
      e.dataTransfer.setDragImage(img, 35, 35);
      e.currentTarget.addEventListener("dragend", () => img.remove(), { once: true });
    }
  }

  function onDragOver(e) {
    if (!isDropTarget || !e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onDragEnter(e) {
    if (!isDropTarget || !e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  async function onDrop(e) {
    if (!isDropTarget || !e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    let refs = [];
    try {
      refs = JSON.parse(e.dataTransfer.getData(INTERNAL_DRAG_MIME) || "[]");
    } catch {
      return;
    }
    refs = refs.filter((r) => r !== blobRef);
    if (refs.length === 0) return;
    await Promise.all(refs.map((r) => addAttribute(blobRef, "camliMember", r)));
    onDroppedMembers?.(blobRef, refs);
  }

  return (
    <div
      className={`item-card card h-100 ${selected ? "border-primary" : ""} ${dragOver ? "item-card-drop-target" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {selectable && (
        <Form.Check
          type="checkbox"
          className="item-card-check position-absolute top-0 start-0 m-1"
          checked={!!selected}
          onChange={(e) => onToggleSelect(blobRef, e)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {showSetBadge && (
        <i
          className={`bi bi-collection item-card-set-badge position-absolute top-0 start-0 m-1 ${selectable ? "ms-4" : ""}`}
          title="Also a set"
        />
      )}
      <div
        className="item-card-body"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(blobRef)}
      >
        <Body disco={disco} meta={meta} item={item} />
      </div>
    </div>
  );
}

function Body({ disco, meta, item }) {
  switch (item.type) {
    case "image":
      return <ImageBody disco={disco} item={item} />;
    case "audio":
      return <AudioBody disco={disco} item={item} />;
    case "video":
      return <VideoBody disco={disco} item={item} />;
    case "twitter":
      return <TwitterBody item={item} />;
    case "mastodon":
      return <MastodonBody item={item} />;
    case "foursquare":
      return <FoursquareBody meta={meta} item={item} />;
    case "instapaper":
      return <InstapaperBody item={item} />;
    case "fitness":
      return <FitnessBody disco={disco} item={item} />;
    case "demo":
      return <DemoBody item={item} />;
    default:
      return <GenericBody meta={meta} item={item} />;
  }
}

function CardFooterTitle({ children }) {
  return <div className="item-card-title small text-truncate px-2 py-1">{children}</div>;
}

function GenericBody({ meta, item }) {
  const isDir = item.file?.dir || (!item.file && !item.blob?.file);
  return (
    <div className="d-flex flex-column h-100 align-items-center justify-content-center text-center p-2">
      <i className={`bi ${isDir ? "bi-folder-fill text-warning" : "bi-file-earmark"} fs-1`} />
      <CardFooterTitle>{titleOf(meta, item.ref)}</CardFooterTitle>
    </div>
  );
}

function ImageBody({ disco, item }) {
  const [loaded, setLoaded] = useState(false);
  const filename = item.file.file?.fileName || "image";
  const src = thumbnailUrl(disco, item.file.blobRef, filename, { mh: bucketHeight(400) });
  return (
    <div className="item-card-image-wrap">
      {!loaded && <div className="item-card-throbber" />}
      <img
        src={src}
        alt={filename}
        className="item-card-image"
        style={{ opacity: loaded ? 1 : 0 }}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}

function AudioBody({ disco, item }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const filename = item.file.file?.fileName || "audio";
  const src = item.file.blobRef ? downloadUrl(disco, item.file.blobRef, filename, { inline: true }) : null;
  return (
    <div className="d-flex flex-column h-100 align-items-center justify-content-center text-center p-2">
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary rounded-circle item-card-play"
        onClick={(e) => {
          e.stopPropagation();
          const el = audioRef.current;
          if (!el) return;
          if (playing) el.pause();
          else el.play();
        }}
      >
        <i className={`bi ${playing ? "bi-pause-fill" : "bi-play-fill"}`} />
      </button>
      <i className="bi bi-volume-up fs-2 mt-2" />
      <CardFooterTitle>{filename}</CardFooterTitle>
      <audio
        ref={audioRef}
        className="d-none"
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
    </div>
  );
}

function VideoBody({ disco, item }) {
  const [started, setStarted] = useState(false);
  const filename = item.file.file?.fileName || "video";
  const src = item.file.blobRef ? downloadUrl(disco, item.file.blobRef, filename, { inline: true }) : null;
  return (
    <div
      className="d-flex flex-column h-100 align-items-center justify-content-center text-center p-2"
      onClick={(e) => {
        if (!started) {
          e.stopPropagation();
          setStarted(true);
        }
      }}
    >
      {started ? (
        <video className="item-card-video" autoPlay controls src={src} />
      ) : (
        <>
          <i className="bi bi-camera-video fs-1" />
          <CardFooterTitle>{filename}</CardFooterTitle>
        </>
      )}
    </div>
  );
}

function TwitterBody({ item }) {
  const attrs = item.blob.permanode.attr;
  return (
    <div className="d-flex flex-column h-100 p-2">
      <div className="text-muted small">{attrs.startDate[0]}</div>
      <div className="flex-grow-1 small overflow-hidden">{attrs.content?.[0] || attrs.title?.[0]}</div>
      <div className="text-end text-primary small"><i className="bi bi-twitter" /> Twitter</div>
    </div>
  );
}

function MastodonBody({ item }) {
  const attrs = item.blob.permanode.attr;
  return (
    <div className="d-flex flex-column h-100 p-2">
      <div className="text-muted small">{attrs.startDate[0]}</div>
      {attrs.spoilerText?.[0] && <div className="fw-bold small">{attrs.spoilerText[0]}</div>}
      {/* Server-trusted HTML, same as the legacy UI (dangerouslySetInnerHTML there too). */}
      <div className="flex-grow-1 small overflow-hidden" dangerouslySetInnerHTML={{ __html: attrs.content[0] }} />
    </div>
  );
}

function FoursquareBody({ meta, item }) {
  const attrs = item.blob.permanode.attr;
  const venueRef = attrs.foursquareVenuePermanode?.[0];
  const venue = venueRef ? meta[venueRef] : null;
  const venueName = venue?.permanode?.attr?.title?.[0] || "Check-in";
  return (
    <div className="d-flex flex-column h-100 justify-content-end p-2 text-white item-card-foursquare">
      <div className="small text-uppercase opacity-75">Check-in at</div>
      <div className="fw-bold">{venueName}</div>
      <div className="small">{attrs.startDate[0]}</div>
    </div>
  );
}

function InstapaperBody({ item }) {
  const attrs = item.blob.permanode.attr;
  const title = (attrs.title?.[0] || "").slice(0, 50);
  const content = (attrs.content?.[0] || "").slice(0, 150);
  return (
    <div className="d-flex flex-column h-100 p-2">
      <div className="text-muted small">{attrs.dateCreated[0]}</div>
      <div className="fw-bold small" dangerouslySetInnerHTML={{ __html: title }} />
      <div className="small overflow-hidden" dangerouslySetInnerHTML={{ __html: content }} />
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return "";
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

function FitnessBody({ disco, item }) {
  const [imgFailed, setImgFailed] = useState(false);
  const attrs = item.blob.permanode.attr;
  const title = attrs.title?.[0] || "Activity";
  const distance = attrs.distanceMeters?.[0];
  const duration = attrs.durationSeconds?.[0];
  const metrics = [
    distance ? `${(Number(distance) / 1000).toFixed(1)} km` : null,
    duration ? formatDuration(Number(duration)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const trackUrl = thumbnailUrl(disco, item.ref, "track.png", { mh: 300 });

  return (
    <div className="d-flex flex-column h-100">
      <div className="flex-grow-1 item-card-image-wrap">
        {imgFailed ? (
          <div className="d-flex align-items-center justify-content-center h-100 text-muted">
            <i className="bi bi-activity fs-1" />
          </div>
        ) : (
          <img src={trackUrl} alt={title} className="item-card-image" onError={() => setImgFailed(true)} />
        )}
      </div>
      <div className="px-2 py-1">
        <div className="small text-truncate fw-bold">{title}</div>
        {metrics && <div className="small text-muted">{metrics}</div>}
      </div>
    </div>
  );
}

function DemoBody({ item }) {
  const attrs = item.blob.permanode.attr;
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="d-flex align-items-center justify-content-center h-100 text-white fw-bold"
      style={{ background: attrs.color?.[0] || "#888" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {attrs.title?.[0]}
      {hovered ? ", mouseover" : ""}
    </div>
  );
}
