import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { CityService, RoadNode } from '../../core/services';
import { TrafficAgent } from './agent';
import type { ControllableVehicle } from './driver';
import { JunctionControl } from './junctions';
import { TRAM_LANE, TrafficGraph } from './roadGraph';
import { SensorField } from './sensors';

function node(id: number, x: number, links: number[]): RoadNode {
  return {
    id,
    position: new THREE.Vector3(x, 0, 0),
    links,
    lanes: 3,
    isIntersection: links.length > 2,
    hasTrafficLight: false,
  };
}

test('right turns choose the kerb lane and left turns choose the inside lane', () => {
  for (const side of [-1, 1]) {
    const nodes = [node(0, 0, [1]), node(1, 100, [0, 2]), node(2, 100, [1])];
    nodes[2].position.z = side * 100;
    const graph = new TrafficGraph({ roadNodes: nodes, tramLines: [], spatial: {
      isBlocked: () => false,
    } } as unknown as CityService);
    const vehicle = { id: 'turn-probe', kind: 'dacia' } as ControllableVehicle;
    const agent = new TrafficAgent(vehicle, graph, graph.edgeBetween(0, 1), 1, new Rng('turn-probe'));
    // East (+X) to +Z is a right turn when viewed from above with Y up.
    const plan = agent as unknown as { planLanes: number[] };
    expect(plan.planLanes[0]).toBe(side > 0 ? 2 : 0);
  }
});

test('a displaced tram re-seats level and tangent-aligned on its physical track', () => {
  const nodes = [node(0, 0, [1]), node(1, 100, [0, 2]), node(2, 200, [1])];
  const city = {
    roadNodes: nodes,
    tramLines: [[
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(100, 0, 0),
      new THREE.Vector3(200, 0, 0),
    ]],
    spatial: {
      snapToRoad: () => false,
      groundHeight: () => 0,
      isBlocked: () => false,
    },
  } as unknown as CityService;
  const graph = new TrafficGraph(city);
  const edge = graph.edges[graph.edgeBetween(0, 1)];
  const rail = graph.lanePoint(edge, TRAM_LANE, 0.5, new THREE.Vector3());
  const position = rail.clone().add(new THREE.Vector3(0, 0.6, 3));
  const rotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2 + THREE.MathUtils.degToRad(18),
  );
  const teleports: Array<{ position: THREE.Vector3; heading: number }> = [];
  const vehicle = {
    id: 'tram-probe',
    kind: 'tram',
    object: new THREE.Group(),
    position,
    rotation,
    speed: 0,
    seats: 60,
    occupants: [],
    health: 4200,
    maxHealth: 4200,
    isWrecked: false,
    setControls: () => undefined,
    setIndicator: () => undefined,
    setHeadlights: () => undefined,
    setSiren: () => undefined,
    applyDamage: () => undefined,
    recover: () => undefined,
    teleport: (next: THREE.Vector3, heading: number) => {
      teleports.push({ position: next.clone(), heading });
      position.copy(next).setY(0.6);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    },
  } as unknown as ControllableVehicle;
  const agent = new TrafficAgent(vehicle, graph, edge.index, TRAM_LANE, new Rng('tram-probe'));
  const junctions = new JunctionControl(nodes);
  const field = new SensorField();
  field.begin();

  for (let i = 0; i < 60; i++) agent.update(1 / 60, field, junctions, { horn: () => undefined });

  expect(teleports.length).toBe(1);
  expect(teleports[0].position.distanceTo(rail)).toBeLessThan(0.05);
  expect(Math.abs(teleports[0].heading - Math.PI / 2)).toBeLessThan(THREE.MathUtils.degToRad(1));
  // Teleport accepts ground height; VehicleHandle adds its own ride height, so
  // a rail recovery can never preserve an airborne/pitched body transform.
  expect(teleports[0].position.y).toBe(0);
});

function carAt(graph: TrafficGraph, edge: number, lane: number, t: number, kind = 'dacia') {
  const e = graph.edges[edge];
  let controls = [0, 0, false] as [number, number, boolean];
  const car = {
    id: 'car', kind, position: graph.lanePoint(e, lane, t, new THREE.Vector3()),
    rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(e.ux, e.uz)),
    speed: 0, isWrecked: false,
    setControls: (throttle: number, steer: number, brake: boolean) => { controls = [throttle, steer, brake]; },
  } as ControllableVehicle;
  return { car, controls: () => controls };
}

function road(nodes: RoadNode[]): TrafficGraph {
  return new TrafficGraph({ roadNodes: nodes, tramLines: [], spatial: { isBlocked: () => false } } as unknown as CityService);
}

test('a red light stops the front bumper before the junction and green restarts it', () => {
  const nodes = [node(0, 0, [1]), node(1, 100, [0, 2]), node(2, 200, [1])];
  nodes[1].hasTrafficLight = true;
  const graph = road(nodes);
  const edge = graph.edgeBetween(0, 1);
  const { car, controls } = carAt(graph, edge, 0, 1);
  car.position.x -= 2.2 + 1.4;
  const agent = new TrafficAgent(car, graph, edge, 0, new Rng(3));
  const junctions = new JunctionControl(nodes);
  const field = new SensorField();
  expect(junctions.signal(1, true)).toBe('red');
  agent.update(1 / 60, field, junctions, { horn: () => {} });
  expect(agent.lastTargetSpeed).toBeCloseTo(0);
  expect(controls()[0]).toBe(0);
  expect(controls()[1]).toBeCloseTo(0);
  expect(controls()[2]).toBe(true);
  junctions.update(junctions.redRemaining(1, true) + .01);
  agent.bid(junctions);
  agent.update(1 / 60, field, junctions, { horn: () => {} });
  expect(agent.lastTargetSpeed).toBeGreaterThan(1);
  expect(controls()[0]).toBeGreaterThan(0);
});

test('route advancement waits for the actual outgoing street on an acute turn', () => {
  const nodes = [node(0, 0, [1]), node(1, 100, [0, 2]), node(2, 0, [1])];
  nodes[2].position.z = -50;
  const graph = road(nodes);
  const edge = graph.edgeBetween(0, 1);
  const { car } = carAt(graph, edge, 0, .2);
  const agent = new TrafficAgent(car, graph, edge, 0, new Rng(3));
  agent.update(1 / 60, new SensorField(), new JunctionControl(nodes), { horn: () => {} });
  expect(agent.edge).toBe(edge);
});

test('the rear of a bus must clear a junction before conflicting traffic may enter', () => {
  const nodes = [node(0, 0, [1]), node(1, 100, [0, 2]), node(2, 200, [1])];
  const graph = road(nodes);
  const edge = graph.edgeBetween(0, 1);
  const next = graph.edgeBetween(1, 2);
  const { car } = carAt(graph, edge, 0, 1, 'bus');
  car.position.x -= 5.85 + 1.4 + 1;
  const agent = new TrafficAgent(car, graph, edge, 0, new Rng(3));
  const junctions = new JunctionControl(nodes);
  const update = () => {
    junctions.update(1 / 60);
    agent.bid(junctions);
    agent.update(1 / 60, new SensorField(), junctions, { horn: () => {} });
  };
  agent.bid(junctions);
  update();
  graph.lanePoint(graph.edges[next], 0, 0, car.position);
  update();
  expect(agent.edge).toBe(next);
  expect(junctions.mayEnter(1, 'crossing', 99)).toBe(false);
  car.position.x += 7;
  update();
  expect(junctions.mayEnter(1, 'crossing', 99)).toBe(true);
});
