import Modal from "react-bootstrap/Modal";
import ProgressBar from "react-bootstrap/ProgressBar";

// Port of the old upload/progress dialog: mascot + status text + a native
// file picker (hidden while busy), also used for drag-and-drop uploads and
// bulk "add to set" progress.
export default function UploadProgressModal({ show, onHide, active, progress, status, onFilesChosen }) {
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
          <input
            type="file"
            multiple
            className="form-control"
            onChange={(e) => {
              if (e.target.files?.length) onFilesChosen(e.target.files);
              e.target.value = "";
            }}
          />
        )}
      </Modal.Body>
    </Modal>
  );
}
