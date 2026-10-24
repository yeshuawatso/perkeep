import { useEffect, useRef, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";

import { detailUrl, getDiscovery, importShare, importShareStatus } from "../api/client.js";

// Header menu -> "Import share": paste a share URL, import runs async
// server-side, poll every 2s for progress (same cadence as the old UI).
export default function ImportShareModal({ show, onHide }) {
  const [url, setUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [resultText, setResultText] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  async function start(e) {
    e.preventDefault();
    setWorking(true);
    setResultText(null);
    await importShare(url);
    pollRef.current = setInterval(async () => {
      const progress = await importShareStatus();
      if (!progress.Running) {
        clearInterval(pollRef.current);
        setWorking(false);
        const disco = await getDiscovery();
        const link = progress.BlobRef ? detailUrl(disco, progress.BlobRef) : null;
        if (progress.Assembled) {
          setResultText(
            link ? (
              <>
                File successfully imported as <a href={link}>{progress.BlobRef}</a>
              </>
            ) : (
              "Import finished."
            ),
          );
        } else {
          setResultText(
            <>
              Done &mdash; {progress.FilesCopied}/{progress.FilesSeen} files imported
              {link && (
                <>
                  {" "}
                  under <a href={link}>{progress.BlobRef}</a>
                </>
              )}
            </>,
          );
        }
      } else {
        setResultText(`Working — ${progress.FilesCopied}/${progress.FilesSeen} files imported`);
      }
    }, 2000);
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Modal.Header closeButton>
        <Modal.Title>Import share</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {resultText ? (
          <div>{resultText}</div>
        ) : (
          <Form onSubmit={start}>
            <Form.Control
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://yourfriendserver/share/sha224-shareclaim"
              disabled={working}
              className="mb-3"
            />
            <Button type="submit" disabled={working || !url}>
              {working ? "Importing…" : "Import"}
            </Button>
          </Form>
        )}
      </Modal.Body>
    </Modal>
  );
}
