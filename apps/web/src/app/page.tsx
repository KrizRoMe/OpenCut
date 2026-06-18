import { redirect } from "next/navigation";

// The home route serves the projects dashboard directly.
export default function Home() {
	redirect("/projects");
}
