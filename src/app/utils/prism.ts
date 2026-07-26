import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-css';

const prismGlobal = globalThis as typeof globalThis & { Prism?: typeof Prism };

if (!prismGlobal.Prism) {
  prismGlobal.Prism = Prism;
}

export { Prism };
