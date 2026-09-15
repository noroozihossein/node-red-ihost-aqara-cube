\# Mr Smart – iHost Aqara Cube Controller



A Node-RED controller for using the Aqara Magic Cube with SONOFF iHost / eWeLink CUBE.



Designed by \*\*Mr Smart\*\* to provide practical multi-target lighting control from Aqara Cube gestures, including brightness adjustment, colour-temperature control and configurable gesture actions.



\## Version



\*\*v0.1.0\*\*



Initial tested release.



\## Main Features



\- Native integration with SONOFF iHost / eWeLink CUBE through Node-RED

\- Aqara Magic Cube gesture handling

\- Multi-target light control

\- Synchronized group mode

\- Relative group mode

\- Configurable gesture actions

\- Light On / Off / Toggle control

\- Brightness Up / Down control

\- Colour Temperature (CCT) Warmer / Cooler control

\- Configurable Brightness Step

\- Configurable CCT Step

\- Temporary CCT Mode

\- Configurable CCT Modifier Gesture

\- Configurable CCT Mode timeout

\- Automatic CCT capability handling

\- Offline-tolerant multi-target operation



\## Temporary CCT Mode



Normal cube rotation can be used for brightness control:



\- Rotate Right → Brightness Up

\- Rotate Left → Brightness Down



A configurable cube gesture can be assigned by the installer as the \*\*CCT Modifier Gesture\*\*.



For example:



\- Shake → Enter Temporary CCT Mode

\- Rotate Right → Cooler

\- Rotate Left → Warmer



The default CCT Mode timeout is \*\*5 seconds\*\*.



Importantly, every valid rotation while CCT Mode is active resets the inactivity timer.



This means the controller will NOT return to Brightness Mode while the user is actively adjusting colour temperature.



Only after the configured period of inactivity does the controller automatically return to normal Brightness control.



The installer can select which supported cube gesture activates Temporary CCT Mode.



\## Group Control Modes



\### Synchronized



All selected target lights are controlled together using a common resulting level.



This is useful when multiple luminaires should behave as one lighting group.



\### Relative



Each selected light retains its relative state while brightness adjustments are applied.



This is useful when several luminaires have different starting brightness levels but should still respond together to the Cube.



Both group modes have been functionally tested on SONOFF iHost.



\## Aqara Cube Gestures



The controller uses the gesture/action information currently exposed by the Aqara Cube through eWeLink CUBE/iHost.



The tested iHost device capability exposes Cube actions including:



\- shake

\- throw

\- wakeup

\- fall

\- tap

\- slide

\- flip90

\- flip180

\- rotate\_left

\- rotate\_right



Gesture assignments can be used to create practical installer-defined lighting controls.



\## Important iHost Limitation



During development and testing, SONOFF iHost/eWeLink CUBE correctly exposed the general Aqara Cube action/gesture capability.



However, detailed Cube orientation information required for advanced face-specific control was not exposed through the currently available CUBE device capability/state interface.



This prevents the controller from reliably distinguishing Cube faces for functions such as:



\- Different actions depending on the active face

\- From-side / To-side automations

\- Face-specific scenes

\- Advanced orientation-based mappings



The same Aqara Cube hardware can provide substantially richer face-based automation when used with platforms/integrations that expose the required Zigbee orientation information.



This limitation is therefore treated as a current iHost/eWeLink CUBE integration limitation rather than a limitation of the Aqara Cube hardware itself.



\## Tested Environment



Initial development and functional testing:



\- SONOFF iHost

\- eWeLink CUBE

\- Node-RED

\- Aqara Magic Cube

\- Multi-target lighting

\- Synchronized mode

\- Relative mode

\- Brightness control

\- Temporary CCT control



\## Installation



Install the package through Node-RED Manage Palette or from a local `.tgz` package during development/testing.



Package name:



`node-red-contrib-mrsmart-ihost-aqara-cube`



\## Current Status



v0.1.0 has completed initial functional testing.



The core multi-target lighting functions and both Synchronized and Relative group-control modes have been tested successfully.



Further development may extend the controller if future SONOFF/eWeLink CUBE updates expose additional Aqara Cube orientation, side or transition information.



\## SONOFF / CoolKit Development Opportunity



The Aqara Cube demonstrates an important opportunity for extending third-party Zigbee device support in eWeLink CUBE.



Exposing additional native Zigbee event data — particularly cube side/orientation and transition information — would allow Node-RED applications and other local integrations to implement substantially richer automation without requiring Home Assistant or another external Zigbee platform.



The findings from this project are intended to be documented separately as technical feedback for SONOFF/CoolKit.



\## Developer



\*\*Mr Smart\*\*



Electrical \& Smart Home Services



\## License



MIT

