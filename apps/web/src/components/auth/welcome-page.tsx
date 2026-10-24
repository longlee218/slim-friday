import { Check } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../ui/button";
import { LoginCard } from "./login-card";

/** `/welcome`: the passkey is saved; open the app. */
export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <LoginCard face={false}>
      <div className="check-big">
        <Check />
      </div>
      <h1>You're in</h1>
      <p>Passkey saved on this device.</p>
      <Button variant="primary" onClick={() => navigate("/")}>
        Open Friday
      </Button>
    </LoginCard>
  );
}
