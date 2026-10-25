import Form from "react-bootstrap/Form";

// Shown under any "new password" field once a server password policy is
// configured (see hooks/usePasswordPolicy.js) -- the plain-language
// description is always required server-side precisely so there's
// something to show here for an arbitrary regex. `matches` is undefined
// before the user has typed anything, or when there's no client-side
// regex preview available (see usePasswordPolicy.js) -- in both cases
// this renders as a neutral hint rather than red/green.
export default function PasswordRequirementHint({ description, matches }) {
  if (!description) return null;
  return <Form.Text className={matches === false ? "text-danger" : "text-muted"}>{description}</Form.Text>;
}
