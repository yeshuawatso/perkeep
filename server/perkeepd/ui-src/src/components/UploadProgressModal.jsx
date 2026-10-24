import { useEffect, useState } from "react";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import ProgressBar from "react-bootstrap/ProgressBar";

import SetPicker from "./SetPicker.jsx";

// Port of the old upload/progress dialog: mascot + status text + a native
// file picker (hidden while busy), also used for drag-and-drop uploads and
// bulk "add to set" progress. `initialParent` (a set's blobref) comes from
// AppLayout's requestUpload()/activeContainer -- when set, the "Add to set"
// toggle defaults on and pre-selects that set (opened via a set's Contents
// tab, or already dropped onto one).
export default function UploadProgressModal({ show, onHide, active, progress, status, initialParent, onFilesChosen }) {
  const [addToSet, setAddToSet] = useState(false);
  const [target, setTarget] = useState(null);

  useEffect(() => {
    if (show) {
      setAddToSet(!!initialParent);
      setTarget(initialParent || null);
    }
  }, [show, initialParent]);

  function filesChosen(files) {
    onFilesChosen(files, addToSet ? target : null);
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Modal.Header closeButton>
        <Modal.Title>Upload</Modal.Title>
      </Modal.Header>
      <Modal.Body className="text-center">
        <i className={`bi ${active ? "bi-cloud-arrow-up" : "bi-cloud-upload"} display-4 mb-3`} />
        <div className="mb-3">{status || "Drop files here to upload, or choose files below."}</div>
        {active && <ProgressBar now={Math.round(progress * 100)} className="mb-3" />}
        {!active && (
          <>
            <input
              type="file"
              multiple
              className="form-control mb-3"
              onChange={(e) => {
                if (e.target.files?.length) filesChosen(e.target.files);
                e.target.value = "";
              }}
            />
            <Form.Switch
              id="upload-add-to-set"
              label="Add to set"
              className="text-start mb-2"
              checked={addToSet}
              onChange={(e) => setAddToSet(e.target.checked)}
            />
            {addToSet && <SetPicker selected={target} onSelect={setTarget} />}
          </>
        )}
      </Modal.Body>
    </Modal>
  );
}
