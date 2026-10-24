import Nav from "react-bootstrap/Nav";
import Offcanvas from "react-bootstrap/Offcanvas";
import { NavLink } from "react-router-dom";

const links = [
  { to: "/", icon: "bi-grid-3x3-gap", label: "Browse" },
  { to: "/map", icon: "bi-geo-alt", label: "Map" },
  { to: "/mobile-setup", icon: "bi-phone", label: "Mobile setup" },
  { to: "/debug", icon: "bi-bug", label: "Debug" },
];

function SidebarNav({ onNavigate }) {
  return (
    <Nav className="flex-column app-sidebar-nav">
      {links.map((l) => (
        <Nav.Link
          as={NavLink}
          key={l.to}
          to={l.to}
          end={l.to === "/"}
          className="d-flex align-items-center gap-2"
          onClick={onNavigate}
        >
          <i className={`bi ${l.icon}`} />
          {l.label}
        </Nav.Link>
      ))}
    </Nav>
  );
}

// Desktop: a static column (rendered by AppLayout at >=lg). Mobile/tablet: an Offcanvas
// drawer toggled from the navbar's hamburger button, so the same nav works at every width
// instead of two different widgets drifting out of sync.
export default function AppSidebar({ show, onHide }) {
  return (
    <>
      <div className="d-none d-lg-block app-sidebar-static border-end">
        <SidebarNav />
      </div>
      <Offcanvas show={show} onHide={onHide} responsive="lg" className="d-lg-none">
        <Offcanvas.Header closeButton>
          <Offcanvas.Title>Perkeep</Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body>
          <SidebarNav onNavigate={onHide} />
        </Offcanvas.Body>
      </Offcanvas>
    </>
  );
}
