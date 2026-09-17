import "./globals.css";

export const metadata = {
  title: "Gold Decision Lab",
  description: "XAU/USD research, signal and paper-trading cockpit",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
