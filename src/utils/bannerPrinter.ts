export function printVentureBanner() {
  const banner = `
  __   __   ______     __   __     ______   __  __     ______     ______    
 /\\ \\ / /  /\\  ___\\   /\\ "-.\\  \\   /\\__  _\\ /\\ \\/\\ \\   /\\  == \\   /\\  ___\\   
 \\ \\ \\'/   \\ \\  __\\   \\ \\ \\-.  \\  \\/_/\\ \\/ \\ \\ \\_\\ \\  \\ \\  __<   \\ \\  __\\   
  \\ \\__|    \\ \\_____\\  \\ \\_\\"\_\\    \\ \\_\\  \\ \\_____\\  \\ \\_\\ \\_\\  \\ \\_____\\ 
   \\/_/      \\/_____/   \\/_/ \\/_/     \\/_/   \\/_____/   \\/_/ /_/   \\/_____/ 
`;

  const style =
    "color: #00ff00; font-weight: bold; font-family: monospace;";

  console.log("%c" + banner, style);
  console.log(
    "%cVENTURE GUI v0.0.1",
    "color: #00ff00; font-weight: bold; font-size: 14px; font-family: monospace;",
  );
  console.log(
    "%cRunning in development mode",
    "color: #00ff00; font-family: monospace;",
  );
}