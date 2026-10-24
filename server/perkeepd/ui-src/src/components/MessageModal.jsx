import Modal from "react-bootstrap/Modal";

// The old UI's one reusable "generic message" dialog (cam.Dialog) --
// used for share-result links and search-expression error surfacing.
export default function MessageModal({ show, onHide, title, children }) {
  return (
    <Modal show={show} onHide={onHide} centered>
      {title && (
        <Modal.Header closeButton>
          <Modal.Title>{title}</Modal.Title>
        </Modal.Header>
      )}
      {!title && (
        <button
          type="button"
          className="btn-close position-absolute top-0 end-0 m-2"
          aria-label="Close"
          onClick={onHide}
        />
      )}
      <Modal.Body>{children}</Modal.Body>
    </Modal>
  );
}
