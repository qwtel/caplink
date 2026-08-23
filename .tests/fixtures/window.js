export function windowEndpoints() {
  const parentEvents = new EventTarget();
  const childEvents = new EventTarget();
  const dispatch = (context, source, origin, data) => queueMicrotask(() => {
    const event = new MessageEvent("message", { data, origin });
    Object.defineProperty(event, "source", { value: source });
    context.dispatchEvent(event);
  });
  const parentWindow = {
    postMessage: (data) => dispatch(parentEvents, childWindow, "https://child.test", data),
  };
  const childWindow = {
    postMessage: (data) => dispatch(childEvents, parentWindow, "https://parent.test", data),
  };
  return {
    parentWindow,
    childWindow,
    parentEvents,
    childEvents,
  };
}

export function controlledEndpoint() {
  const events = new EventTarget();
  const sent = [];
  return {
    endpoint: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      postMessage: (message) => sent.push(message),
    },
    receive(data, origin) {
      events.dispatchEvent(new MessageEvent("message", { data, origin }));
    },
    sent,
  };
}
