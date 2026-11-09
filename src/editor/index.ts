// Level editor screen ('editor'). See docs/levels.md.
import { registerScreen } from '../app/router'
import { createEditor } from './editor'
import './editor.css'

registerScreen('editor', createEditor)
